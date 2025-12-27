// scripts/recalcLoanTerms.js
// Recalculate repayment schedule rows for specific loans.
// Usage examples (from project root):
//   node scripts/recalcLoanTerms.js --ids=64f...,650... --mode=term --commit
//   node scripts/recalcLoanTerms.js --fundedSince=2025-01-01 --mode=term --dry
//   node scripts/recalcLoanTerms.js --ids=64f... --mode=apr --bump=2 --dry
//
// Flags:
//   --ids=<comma separated loan ids>        Recalc only these loans
//   --fundedSince=YYYY-MM-DD                Recalc loans funded on/after date (if --ids not given)
//   --mode=term|apr                         Interest model (default: term)
//   --bump=<number>                         Extra % points to add to loan.interestRate (default 2)
//   --peerfund=<decimal>                    Override peerfund fee rate (default from utils/fees or 0.01)
//   --bank=<decimal>                        Override banking fee rate (default from utils/fees or 0.01)
//   --touchPaid                             Also update PAID rows (default false)
//   --commit                                Actually write changes (default: dry-run)
//   --dry                                   Force dry-run (no writes; default if --commit not set)

const path = require('path');
const r2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// Try to load your existing fee constants; fall back to 1%
let PEERFUND_FEE_RATE = 0.01;
let BANKING_FEE_RATE = 0.01;
try {
  const fees = require(path.join(__dirname, '..', 'src', 'utils', 'fees'));
  if (typeof fees.PEERFUND_FEE_RATE === 'number') PEERFUND_FEE_RATE = fees.PEERFUND_FEE_RATE;
  if (typeof fees.BANKING_FEE_RATE === 'number') BANKING_FEE_RATE = fees.BANKING_FEE_RATE;
} catch (_) {}

const prisma = require(path.join(__dirname, '..', 'src', 'utils', 'prisma'));

// ----- simple arg parsing -----
const argv = process.argv.slice(2).reduce((acc, item) => {
  const [k, v] = item.split('=');
  const key = k.replace(/^--/, '');
  acc[key] = v === undefined ? true : v;
  return acc;
}, {});

const MODE = (argv.mode || 'term').toLowerCase(); // 'term' or 'apr'
const BUMP = Number(argv.bump ?? 2);
const TOUCH_PAID = Boolean(argv.touchPaid);
const COMMIT = Boolean(argv.commit) && !Boolean(argv.dry);

if (!['term', 'apr'].includes(MODE)) {
  console.error('Invalid --mode (use "term" or "apr").'); process.exit(1);
}
if (!Number.isFinite(BUMP)) {
  console.error('Invalid --bump (must be a number).'); process.exit(1);
}

if (argv.peerfund !== undefined) {
  const pf = Number(argv.peerfund);
  if (!Number.isFinite(pf) || pf < 0) { console.error('Invalid --peerfund'); process.exit(1); }
  PEERFUND_FEE_RATE = pf;
}
if (argv.bank !== undefined) {
  const bk = Number(argv.bank);
  if (!Number.isFinite(bk) || bk < 0) { console.error('Invalid --bank'); process.exit(1); }
  BANKING_FEE_RATE = bk;
}

function info(...args){ console.log('[recalc]', ...args); }

// ----- interest helpers -----
function baseMonthly_TERM(amount, baseRatePct, duration) {
  const termRate = baseRatePct / 100;
  const totalBase = r2(amount * (1 + termRate));
  return r2(totalBase / duration);
}
function baseMonthly_APR(amount, baseRatePct, duration) {
  const monthly = (baseRatePct / 100) / 12;
  return r2((amount * monthly) / (1 - Math.pow(1 + monthly, -duration)));
}

async function fetchLoans() {
  if (argv.ids) {
    const ids = String(argv.ids).split(',').map(s => s.trim()).filter(Boolean);
    if (ids.length === 0) {
      console.error('No valid ids in --ids'); process.exit(1);
    }
    info(`Targeting ${ids.length} loan(s) by id.`);
    return prisma.loan.findMany({
      where: { id: { in: ids } },
      include: { lender: { select: { isSuperUser: true } }, repayments: true }
    });
  }

  if (argv.fundedSince) {
    const since = new Date(argv.fundedSince);
    if (Number.isNaN(since.getTime())) {
      console.error('Bad --fundedSince date. Use YYYY-MM-DD.'); process.exit(1);
    }
    info(`Targeting loans funded on/after ${since.toISOString().slice(0,10)}`);
    return prisma.loan.findMany({
      where: { fundedDate: { gte: since } },
      include: { lender: { select: { isSuperUser: true } }, repayments: true }
    });
  }

  console.error('Provide --ids=<...> or --fundedSince=YYYY-MM-DD'); process.exit(1);
}

async function run() {
  const loans = await fetchLoans();
  if (loans.length === 0) { info('No loans matched.'); return; }

  info(`Mode = ${MODE.toUpperCase()}, bump = +${BUMP}%  | fees: PF=${PEERFUND_FEE_RATE}, BANK=${BANKING_FEE_RATE}`);
  if (!COMMIT) info('DRY RUN (no writes). Use --commit to save changes.');
  if (TOUCH_PAID) info('Will update PAID rows as well (history change).');

  for (const loan of loans) {
    const baseRatePct = (Number(loan.interestRate) || 0) + BUMP;
    const amount = Number(loan.amount) || 0;
    const duration = Number(loan.duration) || 1;

    const baseMonthly =
      MODE === 'term'
        ? baseMonthly_TERM(amount, baseRatePct, duration)
        : baseMonthly_APR(amount, baseRatePct, duration);

    const pfEach   = loan.lender?.isSuperUser ? 0 : r2(baseMonthly * PEERFUND_FEE_RATE);
    const bankEach = r2(baseMonthly * BANKING_FEE_RATE);
    const totalEach = r2(baseMonthly + pfEach + bankEach);

    const rows = loan.repayments || [];
    const toChange = rows.filter(r => TOUCH_PAID || r.status !== 'PAID');

    info(`Loan ${loan.id}  amount=$${amount}  rate=${baseRatePct}%  duration=${duration}  -> baseMonthly=$${baseMonthly}`);
    info(`  Updating ${toChange.length}/${rows.length} repayment row(s)`);

    for (const rp of toChange) {
      const before = {
        basePayment: rp.basePayment, bankingFee: rp.bankingFee,
        peerfundFee: rp.peerfundFee, total: rp.totalCharged
      };
      const after = {
        basePayment: baseMonthly, bankingFee: bankEach,
        peerfundFee: pfEach, total: totalEach
      };

      if (!COMMIT) {
        info(`    [dry] ${rp.id}:`, before, '=>', after);
      } else {
        await prisma.repayment.update({
          where: { id: rp.id },
          data: {
            basePayment: baseMonthly,
            bankingFee: bankEach,
            peerfundFee: pfEach,
            totalCharged: totalEach,
            amountDue: totalEach,
          }
        });
        info(`    saved ${rp.id}`);
      }
    }
  }

  info('Done.');
}

run()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });
