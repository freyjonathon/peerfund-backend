// utils/paymentProcessor.js
const prisma = require('./prisma');
const { calcFees } = require('./fees'); // { peerfundFee, bankingFee, totalFees, totalCharge }

// Optional explicit recipients for fee rows
const OVERRIDE_PF_USER_ID   = process.env.PEERFUND_USER_ID || null;
const OVERRIDE_BANK_USER_ID = process.env.BANK_USER_ID     || null;

let cachedAdminId = null;
async function getAdminUserId() {
  if (cachedAdminId) return cachedAdminId;

  // Fallback: find any ADMIN
  const admin = await prisma.user.findFirst({ where: { role: 'ADMIN' }, select: { id: true } });
  if (admin?.id) {
    cachedAdminId = admin.id;
    return cachedAdminId;
  }
  console.warn('⚠️ No ADMIN user found. Fee transactions will not be linked to a user.');
  return null;
}

async function getFeeRecipients() {
  // Prefer the explicit env overrides; otherwise use the single admin id for both
  const adminId = await getAdminUserId();
  return {
    pfRecipientId:   OVERRIDE_PF_USER_ID   || adminId,
    bankRecipientId: OVERRIDE_BANK_USER_ID || adminId,
  };
}

/**
 * Process a payment and persist:
 * - Transactions (base to lender, fee rows to recipients)
 * - Repayment row (if repaymentId provided)
 * - Fee audit rows (Fee table)
 *
 * Params:
 * {
 *   type: 'DISBURSEMENT' | 'REPAYMENT',
 *   fromUserId: string,
 *   toUserId: string,        // lender for repayments, borrower for disbursement
 *   loanId: string,
 *   repaymentId?: string,    // required for REPAYMENT
 *   baseAmount?: number,     // preferred (pre-fee base)
 *   borrowerIsSuperUser?: boolean,
 *   amount?: number,         // fallback total if baseAmount not provided
 * }
 */
async function processPayment({
  type,
  fromUserId,
  toUserId,
  loanId,
  repaymentId = null,
  baseAmount,
  borrowerIsSuperUser = false,
  amount,
}) {
  const now = new Date();

  if (!type || !fromUserId || !toUserId || !loanId) {
    throw new Error('Missing required params: type, fromUserId, toUserId, loanId');
  }
  if (type === 'REPAYMENT' && !repaymentId) {
    throw new Error('Repayment ID is required for REPAYMENT type');
  }

  // --- Compute fee breakdown from base (preferred) or total ---
  let base = Number(baseAmount);
  let pf = 0, bf = 0, total = 0;

  if (Number.isFinite(base)) {
    let { peerfundFee, bankingFee, totalCharge } = calcFees(base);
    if (borrowerIsSuperUser) {
      peerfundFee = 0;
      totalCharge = Number((base + bankingFee).toFixed(2));
    }
    pf = Number(peerfundFee.toFixed(2));
    bf = Number(bankingFee.toFixed(2));
    total = Number(totalCharge.toFixed(2));
  } else if (Number.isFinite(amount)) {
    const totalGiven = Number(amount);
    const RATE = 0.02 + 0.05; // keep in sync with fees.js if you change rates
    base = Number((totalGiven / (1 + RATE)).toFixed(2));
    let { peerfundFee, bankingFee, totalCharge } = calcFees(base);
    if (borrowerIsSuperUser) {
      peerfundFee = 0;
      totalCharge = Number((base + bankingFee).toFixed(2));
    }
    pf = Number(peerfundFee.toFixed(2));
    bf = Number(bankingFee.toFixed(2));
    total = Number(totalCharge.toFixed(2));
    console.warn('[paymentProcessor] Approximated base from total. Pass baseAmount for exact math.');
  } else {
    throw new Error('Provide baseAmount (preferred) or amount (total) to processPayment');
  }

  console.log(`💸 Processing ${type}: base=${base} | bankFee=${bf} | peerFundFee=${pf} | total=${total}`);

  // ----------------- DISBURSEMENT -----------------
  if (type === 'DISBURSEMENT') {
    // Single transaction: lender -> borrower (no fees on this row)
    await prisma.transaction.create({
      data: {
        type,
        amount: base,
        peerfundFee: 0,
        bankingFee: 0,
        fromUserId,
        toUserId,
        loanId,
        processedAt: now,
        timestamp: now,
      },
    });
    return { success: true, processedAt: now, base, bankingFee: 0, peerfundFee: 0, total };
  }

  // ----------------- REPAYMENT -----------------
  if (type === 'REPAYMENT') {
    const { pfRecipientId, bankRecipientId } = await getFeeRecipients();

    // 1) Mark the repayment row paid with full breakdown
    await prisma.repayment.update({
      where: { id: repaymentId },
      data: {
        status: 'PAID',
        paidAt: now,
        basePayment: base,
        bankingFee: bf,
        peerfundFee: pf,
        totalCharged: total,
        amountPaid: total,
      },
    });

    // 2a) Borrower -> Lender (base)
    if (base > 0) {
      await prisma.transaction.create({
        data: {
          type, // 'REPAYMENT'
          amount: base,
          peerfundFee: 0,
          bankingFee: 0,
          fromUserId,      // borrower
          toUserId,        // lender
          loanId,
          repaymentId,
          processedAt: now,
          timestamp: now,
        },
      });
    }

    // 2b) Borrower -> Bank user (banking fee)
    if (bf > 0 && bankRecipientId) {
      await prisma.transaction.create({
        data: {
          type: 'BANK_FEE',
          amount: bf,
          peerfundFee: 0,
          bankingFee: bf,
          fromUserId,
          toUserId: bankRecipientId,
          loanId,
          repaymentId,
          processedAt: now,
          timestamp: now,
        },
      });
    } else if (bf > 0) {
      console.warn('⚠️ No bank fee recipient—BANK_FEE transaction skipped.');
    }

    // 2c) Borrower -> PeerFund user (platform fee) — skipped if super user (pf === 0)
    if (pf > 0 && pfRecipientId) {
      await prisma.transaction.create({
        data: {
          type: 'PLATFORM_FEE',
          amount: pf,
          peerfundFee: pf,
          bankingFee: 0,
          fromUserId,
          toUserId: pfRecipientId,
          loanId,
          repaymentId,
          processedAt: now,
          timestamp: now,
        },
      });
    } else if (pf > 0) {
      console.warn('⚠️ No platform fee recipient—PLATFORM_FEE transaction skipped.');
    }

    // 3) Fee audit rows (optional, for reporting)
    const feeRows = [];
    if (bf > 0) feeRows.push({ loanId, repaymentId, type: 'BANK_FEE',     amount: bf });
    if (pf > 0) feeRows.push({ loanId, repaymentId, type: 'PLATFORM_FEE', amount: pf });
    if (feeRows.length) await prisma.fee.createMany({ data: feeRows });

    console.log(`✅ Repayment ${repaymentId} marked PAID; fees recorded.`);
    return { success: true, processedAt: now, base, bankingFee: bf, peerfundFee: pf, total };
  }

  throw new Error(`Unsupported payment type: ${type}`);
}

module.exports = { processPayment };
