// src/controllers/paymentController.js
const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const { calcFees } = require('../utils/fees'); // 2% PF, 5% Banking

/**
 * Start a Stripe Checkout session for a loan repayment
 * Body: { loanId: string, repaymentId: string }
 */
async function createRepaymentCheckout(req, res) {
  try {
    const { loanId, repaymentId } = req.body;
    const userId = req.user.userId; // from authenticateToken

    if (!loanId || !repaymentId) {
      return res.status(400).json({ error: 'loanId and repaymentId are required' });
    }

    // Pull repayment + loan to compute amount using our shared fee logic
    const repayment = await prisma.repayment.findUnique({
      where: { id: repaymentId },
      include: {
        loan: { include: { borrower: { select: { isSuperUser: true } } } },
      },
    });
    if (!repayment || repayment.loanId !== loanId) {
      return res.status(404).json({ error: 'Repayment not found for this loan' });
    }

    const base = Number(repayment.basePayment) || Number(repayment.amountDue) || 0;
    if (base <= 0) return res.status(400).json({ error: 'Nothing to pay for this repayment' });

    // Compute (or reuse) the fees
    let { peerfundFee, bankingFee, totalCharge } = calcFees(base);
    if (repayment.loan.borrower.isSuperUser) {
      peerfundFee = 0;
      totalCharge = Number((base + bankingFee).toFixed(2));
    }

    // If the row already has fees, prefer them (idempotence)
    const pf  = typeof repayment.peerfundFee === 'number' ? repayment.peerfundFee : peerfundFee;
    const bf  = typeof repayment.bankingFee  === 'number' ? repayment.bankingFee  : bankingFee;
    const ttl = typeof repayment.totalCharged === 'number' ? repayment.totalCharged : Number((base + pf + bf).toFixed(2));

    // Optional: fetch user email for Checkout
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'], // If you want ACH via Checkout, you can enable us_bank_account too.
      customer_email: user?.email || undefined,
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: { name: `Loan Repayment #${repaymentId}` },
            unit_amount: Math.round(ttl * 100),
          },
          quantity: 1,
        },
      ],
      success_url: `${process.env.CLIENT_URL}/repayment/success?loanId=${loanId}&repaymentId=${repaymentId}`,
      cancel_url: `${process.env.CLIENT_URL}/repayment/cancel?loanId=${loanId}&repaymentId=${repaymentId}`,
      metadata: {
        kind: 'REPAYMENT',
        loanId,
        repaymentId,
        payerUserId: userId,
        // store breakdown as metadata for easy debugging
        base: String(base),
        peerfundFee: String(pf),
        bankingFee: String(bf),
        total: String(ttl),
      },
    });

    return res.json({ url: session.url });
  } catch (err) {
    console.error('createRepaymentCheckout error:', err);
    return res.status(500).json({ error: 'Failed to create repayment session' });
  }
}

/**
 * Stripe webhook (remember: raw body!)
 * server.js must mount this route with express.raw({ type: 'application/json' })
 */
async function webhook(req, res) {
  try {
    const sig = req.headers['stripe-signature'];
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    } catch (err) {
      console.error('Webhook signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;

      if (session.metadata?.kind === 'REPAYMENT') {
        const { loanId, repaymentId } = session.metadata;

        // Re-fetch repayment + loan to persist fee breakdown accurately
        const repayment = await prisma.repayment.findUnique({
          where: { id: repaymentId },
          include: {
            loan: { include: { borrower: { select: { isSuperUser: true } } } },
          },
        });
        if (!repayment || repayment.loanId !== loanId) {
          console.warn('Repayment not found / mismatched loan on webhook');
        } else {
          const base = Number(repayment.basePayment) || Number(repayment.amountDue) || 0;
          let { peerfundFee, bankingFee, totalCharge } = calcFees(base);
          if (repayment.loan.borrower.isSuperUser) {
            peerfundFee = 0;
            totalCharge = Number((base + bankingFee).toFixed(2));
          }

          const pf  = typeof repayment.peerfundFee === 'number' ? repayment.peerfundFee : peerfundFee;
          const bf  = typeof repayment.bankingFee  === 'number' ? repayment.bankingFee  : bankingFee;
          const ttl = session.amount_total != null
            ? Number((session.amount_total / 100).toFixed(2))
            : (typeof repayment.totalCharged === 'number' ? repayment.totalCharged : Number((base + pf + bf).toFixed(2)));

          // Mark paid & persist breakdown
          await prisma.repayment.update({
            where: { id: repaymentId },
            data: {
              amountPaid: ttl,
              basePayment: base,
              peerfundFee: Number(pf.toFixed(2)),
              bankingFee: Number(bf.toFixed(2)),
              totalCharged: ttl,
              status: 'PAID',
              paidAt: new Date(),
            },
          });

          // Fee audit rows (idempotency-ish: if you expect retries, consider upsert-by (loanId, repaymentId, type, amount))
          const feeRows = [];
          if (bf > 0) feeRows.push({ loanId, repaymentId, type: 'BANK_FEE',     amount: Number(bf.toFixed(2)) });
          if (pf > 0) feeRows.push({ loanId, repaymentId, type: 'PLATFORM_FEE', amount: Number(pf.toFixed(2)) });
          if (feeRows.length) await prisma.fee.createMany({ data: feeRows });
        }
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Webhook handler error:', err);
    res.status(500).json({ error: 'Webhook handler failed' });
  }
}

module.exports = {
  createRepaymentCheckout,
  webhook,
};
