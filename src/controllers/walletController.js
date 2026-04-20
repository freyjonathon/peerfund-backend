// src/controllers/walletController.js
const prisma = require('../utils/prisma');
const { getWalletOrCreate } = require('../utils/wallet');
const { getUserId } = require('../middleware/authMiddleware');

const stripeSecret = process.env.STRIPE_SECRET_KEY || '';
const stripe = stripeSecret ? require('stripe')(stripeSecret) : null;

/**
 * GET /api/wallet/me
 */
exports.getMyWallet = async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const wallet = await getWalletOrCreate(userId);

    const ledger = await prisma.walletLedger.findMany({
      where: { walletId: wallet.id },
      orderBy: { createdAt: 'desc' },
      take: 25,
    });

    return res.json({
      available: wallet.availableCents / 100,
      pending: wallet.pendingCents / 100,
      availableCents: wallet.availableCents,
      pendingCents: wallet.pendingCents,
      ledger,
    });
  } catch (err) {
    console.error('getMyWallet error:', err);
    return res.status(500).json({ error: 'Failed to fetch wallet' });
  }
};

/**
 * LEGACY: Stripe webhook
 * Wallet crediting is done immediately after a successful PaymentIntent,
 * so this can remain a no-op for now.
 */
exports.stripeWebhook = async (_req, res) => {
  if (!stripe) return res.status(501).send('Stripe not configured');
  try {
    return res.json({ received: true });
  } catch (err) {
    console.error('stripeWebhook error:', err);
    return res.status(500).send('Internal webhook error');
  }
};

/**
 * LEGACY DEV helper – no longer used.
 */
exports.devConfirmDeposit = async (_req, res) => {
  return res.status(501).json({ error: 'devConfirmDeposit is no longer used' });
};

/**
 * POST /api/wallet/deposit
 * Body: { amountDollars }
 *
 * Real money flow:
 *  - Uses the user's saved funding card
 *  - Creates and confirms a Stripe PaymentIntent server-side
 *  - On success, credits wallet.availableCents
 *  - Writes a DEPOSIT ledger row
 */
exports.depositFromFundingCard = async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    const { amountDollars } = req.body || {};
    const dollars = Number(amountDollars);

    if (!Number.isFinite(dollars) || dollars <= 0) {
      return res.status(400).json({
        ok: false,
        error: 'Valid amountDollars is required',
      });
    }

    const amountCents = Math.round(dollars * 100);

    if (!stripe) {
      return res.status(500).json({
        ok: false,
        error: 'Stripe not configured',
      });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        stripeCustomerId: true,
        fundingPaymentMethodId: true,
      },
    });

    if (!user?.stripeCustomerId || !user?.fundingPaymentMethodId) {
      return res.status(400).json({
        ok: false,
        error: 'No saved funding card found. Please set it up first.',
      });
    }

    const wallet = await getWalletOrCreate(userId);

    // Create + confirm PaymentIntent using saved funding method
    const pi = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: 'usd',
      customer: user.stripeCustomerId,
      payment_method: user.fundingPaymentMethodId,
      off_session: true,
      confirm: true,
      metadata: {
        userId,
        walletId: wallet.id,
        purpose: 'wallet_deposit',
      },
    });

    if (pi.status !== 'succeeded') {
      return res.status(400).json({
        ok: false,
        error: `PaymentIntent not succeeded (status=${pi.status})`,
      });
    }

    // Credit wallet balance
    const updatedWallet = await prisma.wallet.update({
      where: { id: wallet.id },
      data: {
        availableCents: { increment: amountCents },
      },
    });

    // Write ledger row using the actual post-deposit balance
    await prisma.walletLedger.create({
      data: {
        walletId: wallet.id,
        type: 'DEPOSIT',
        amountCents,
        direction: 'CREDIT',
        balanceAfterCents: updatedWallet.availableCents,
        referenceType: 'StripePI',
        referenceId: pi.id,
        metadata: {
          externalId: pi.id,
          provider: 'stripe',
          status: pi.status,
        },
      },
    });

    return res.json({
      ok: true,
      availableCents: updatedWallet.availableCents,
      pendingCents: updatedWallet.pendingCents,
      available: updatedWallet.availableCents / 100,
      pending: updatedWallet.pendingCents / 100,
      paymentIntentId: pi.id,
    });
  } catch (err) {
    console.error('depositFromFundingCard error:', err);

    const stripeMsg =
      err?.raw?.message ||
      err?.message ||
      'Failed to deposit from funding card';

    return res.status(500).json({
      ok: false,
      error: stripeMsg,
    });
  }
};

/**
 * POST /api/wallet/withdraw
 * Body: { amountDollars }
 *
 * For now:
 *  - validates amount
 *  - checks wallet balance
 *  - decrements availableCents
 *  - writes a ledger row
 *
 * This does NOT yet push real money back to a bank/card.
 * It only updates the in-app wallet.
 */
exports.withdrawFunds = async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { amountDollars } = req.body || {};
    const dollars = Number(amountDollars);

    if (!Number.isFinite(dollars) || dollars <= 0) {
      return res.status(400).json({
        ok: false,
        error: 'Valid amountDollars is required',
      });
    }

    const amountCents = Math.round(dollars * 100);
    const wallet = await getWalletOrCreate(userId);

    if (wallet.availableCents < amountCents) {
      return res.status(400).json({
        ok: false,
        error: 'Insufficient wallet balance for withdrawal',
      });
    }

    const updatedWallet = await prisma.wallet.update({
      where: { id: wallet.id },
      data: {
        availableCents: { decrement: amountCents },
      },
    });

    await prisma.walletLedger.create({
      data: {
        walletId: wallet.id,
        type: 'WITHDRAWAL',
        amountCents,
        direction: 'DEBIT',
        balanceAfterCents: updatedWallet.availableCents,
        referenceType: 'ManualPayout',
        referenceId: null,
        metadata: {
          status: 'COMPLETED',
          provider: stripe ? 'stripe' : 'simulated',
        },
      },
    });

    return res.json({
      ok: true,
      availableCents: updatedWallet.availableCents,
      pendingCents: updatedWallet.pendingCents,
      available: updatedWallet.availableCents / 100,
      pending: updatedWallet.pendingCents / 100,
    });
  } catch (err) {
    console.error('withdrawFunds error:', err);
    return res.status(500).json({
      ok: false,
      error: err?.message || 'Failed to withdraw funds',
    });
  }
};