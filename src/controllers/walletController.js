// src/controllers/walletController.js
const prisma = require('../utils/prisma');
const { getWalletOrCreate } = require('../utils/wallet');
const { getUserId } = require('../middleware/authMiddleware');

const stripeSecret = process.env.STRIPE_SECRET_KEY || '';
const stripe = stripeSecret ? require('stripe')(stripeSecret) : null;

/**
 * Create a ledger row compatible with WalletLedger model
 * and keep balanceAfterCents in sync.
 */
async function createLedger(walletId, data) {
  const wallet = await prisma.wallet.findUnique({ where: { id: walletId } });
  const current = wallet?.availableCents ?? 0;

  const amountCents = Number(data.amountCents || 0);
  const direction = data.direction === 'DEBIT' ? 'DEBIT' : 'CREDIT';

  const delta = direction === 'DEBIT' ? -amountCents : amountCents;
  const balanceAfterCents = current + delta;

  return prisma.walletLedger.create({
    data: {
      walletId,
      type: data.type,                // WalletEntryType enum
      amountCents,
      direction,                      // "CREDIT" | "DEBIT"
      balanceAfterCents,
      referenceType: data.referenceType || null,
      referenceId: data.referenceId || null,
      metadata: data.metadata || {},  // Json field
    },
  });
}

async function incrementAvailable(walletId, amountCents) {
  await prisma.wallet.update({
    where: { id: walletId },
    data: { availableCents: { increment: amountCents } },
  });
}

/** GET /api/wallet/me */
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
 * POST /api/wallet/deposit-intent
 *
 * Server-side wallet deposit using the user's saved funding card.
 * Body: { amountDollars }  // e.g. "25.00" or 25
 *
 * Flow:
 *  - Look up current user + wallet
 *  - Require user.stripeCustomerId and user.fundingPaymentMethodId
 *  - Create & confirm a Stripe PaymentIntent off_session
 *  - On success, increment wallet.availableCents and write a DEPOSIT ledger row
 *  - Return updated wallet snapshot (no clientSecret needed)
 */
exports.createDepositIntent = async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { amountDollars } = req.body || {};
    const dollars = Number(amountDollars);
    if (!Number.isFinite(dollars) || dollars <= 0) {
      return res.status(400).json({ error: 'Valid amountDollars is required' });
    }

    const amountCents = Math.round(dollars * 100);
    const wallet = await getWalletOrCreate(userId);

    // If we have a Stripe secret key, create a real PaymentIntent
    if (stripe) {
      const pi = await stripe.paymentIntents.create({
        amount: amountCents,
        currency: 'usd',
        metadata: {
          userId,
          walletId: wallet.id,
          purpose: 'wallet_deposit',
        },
        automatic_payment_methods: { enabled: true },
      });

      // Just return the client_secret; front-end will confirm the card
      return res.json({
        clientSecret: pi.client_secret,
        simulated: false,
      });
    }

    // Fallback: no Stripe configured → simulate instant deposit
    await incrementAvailable(wallet.id, amountCents);
    await createLedger(wallet.id, {
      type: 'DEPOSIT',
      amountCents,
      direction: 'CREDIT',
      referenceType: 'Simulated',
      referenceId: null,
      metadata: { status: 'SETTLED', provider: 'simulated' },
    });

    const updated = await prisma.wallet.findUnique({ where: { id: wallet.id } });
    return res.json({
      simulated: true,
      availableCents: updated.availableCents,
      available: updated.availableCents / 100,
    });
  } catch (err) {
    console.error('createDepositIntent error:', err);
    return res.status(500).json({ error: 'Failed to create deposit' });
  }
};

/**
 * LEGACY: Stripe webhook
 * With the new design we credit the wallet immediately after a
 * successful PaymentIntent, so this can safely be a no-op for now.
 */
exports.stripeWebhook = async (req, res) => {
  if (!stripe) return res.status(501).send('Stripe not configured');
  try {
    // You can still verify & log events here if you like,
    // but wallet balances no longer depend on this.
    return res.json({ received: true });
  } catch (err) {
    console.error('stripeWebhook error:', err);
    return res.status(500).send('Internal webhook error');
  }
};

/**
 * LEGACY DEV helper – no longer needed with server-side deposits.
 */
exports.devConfirmDeposit = async (_req, res) => {
  return res.status(501).json({ error: 'devConfirmDeposit is no longer used' });
};

exports.depositFromFundingCard = async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: 'Unauthorized' });

    const { amountDollars } = req.body || {};
    const dollars = Number(amountDollars);
    if (!Number.isFinite(dollars) || dollars <= 0) {
      return res.status(400).json({ ok: false, error: 'Valid amountDollars is required' });
    }
    const amountCents = Math.round(dollars * 100);

    if (!stripe) {
      return res.status(500).json({ ok: false, error: 'Stripe not configured' });
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user?.stripeCustomerId || !user?.fundingPaymentMethodId) {
      return res.status(400).json({
        ok: false,
        error: 'No saved funding card found. Please set it up first.',
      });
    }

    const wallet = await getWalletOrCreate(userId);

    // Create + confirm PaymentIntent using saved pm
    const pi = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: 'usd',
      customer: user.stripeCustomerId,
      payment_method: user.fundingPaymentMethodId,
      off_session: true,
      confirm: true,
    });

    if (pi.status !== 'succeeded') {
      return res.status(400).json({
        ok: false,
        error: `PaymentIntent not succeeded (status=${pi.status})`,
      });
    }

    // Update wallet
    await prisma.wallet.update({
      where: { id: wallet.id },
      data: { availableCents: { increment: amountCents } },
    });

    const updatedWallet = await prisma.wallet.findUnique({ where: { id: wallet.id } });

    await prisma.walletLedger.create({
      data: {
        walletId: wallet.id,
        type: 'DEPOSIT',
        amountCents,
        direction: 'CREDIT',
        balanceAfterCents: updatedWallet.availableCents,
        referenceType: 'StripePI',
        referenceId: updatedWallet.id,
        metadata: {
          externalId: pi.id,
          provider: 'stripe',
          status: 'SUCCEEDED',
        },
      },
    });

    return res.json({
      ok: true,
      availableCents: updatedWallet.availableCents,
      pendingCents: updatedWallet.pendingCents,
    });
  } catch (err) {
    console.error('depositFromFundingCard error:', err);
    return res.status(500).json({
      ok: false,
      error: err?.message || 'Failed to deposit from funding card',
    });
  }
};

/**
 * POST /api/wallet/withdraw
 * Body: { amountDollars }
 *
 * For now this:
 *  - validates the amount
 *  - checks the user has enough wallet balance
 *  - decrements availableCents
 *  - writes a ledger row
 * No actual Stripe payout yet – that can be wired up later.
 */
exports.withdrawFunds = async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { amountDollars } = req.body || {};
    const dollars = Number(amountDollars);

    if (!Number.isFinite(dollars) || dollars <= 0) {
      return res
        .status(400)
        .json({ error: 'Valid amountDollars is required' });
    }

    const amountCents = Math.round(dollars * 100);

    // Make sure the user has a wallet and enough balance
    const wallet = await getWalletOrCreate(userId);

    if (wallet.availableCents < amountCents) {
      return res
        .status(400)
        .json({ error: 'Insufficient wallet balance for withdrawal' });
    }

    // Decrement available balance
    const updatedWallet = await prisma.wallet.update({
      where: { id: wallet.id },
      data: {
        availableCents: { decrement: amountCents },
      },
    });

    // Record ledger entry – adjust `type` to match your enum
    await createLedger(wallet.id, {
      type: 'WITHDRAWAL',        // ✅ make sure this exists in your WalletEntryType enum
      amountCents,
      direction: 'DEBIT',        // money leaving wallet
      referenceType: 'ManualPayout',
      referenceId: null,
      metadata: {
        status: 'COMPLETED',
        provider: stripe ? 'stripe' : 'simulated',
      },
    });

    return res.json({
      ok: true,
      availableCents: updatedWallet.availableCents,
      available: updatedWallet.availableCents / 100,
    });
  } catch (err) {
    console.error('withdrawFunds error:', err);
    return res.status(500).json({ error: 'Failed to withdraw funds' });
  }
};
