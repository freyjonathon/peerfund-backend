// src/controllers/walletController.js
const prisma = require('../utils/prisma');
const { getWalletOrCreate } = require('../utils/wallet');
const { getUserId } = require('../middleware/authMiddleware');
const { stripe, getConnectAccount } = require('../lib/stripeIdentities');

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

    // 1) Charge the saved funding card
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

    // 2) Update wallet + ledger atomically
    const updatedWallet = await prisma.$transaction(async (tx) => {
      const updated = await tx.wallet.update({
        where: { id: wallet.id },
        data: {
          availableCents: { increment: amountCents },
        },
      });

      await tx.walletLedger.create({
        data: {
          walletId: wallet.id,
          type: 'DEPOSIT',
          amountCents,
          direction: 'CREDIT',
          balanceAfterCents: updated.availableCents,
          referenceType: 'StripePI',
          // Do NOT store pi.id in referenceId if that field expects ObjectId/other constrained format
          referenceId: null,
          metadata: {
            externalId: pi.id,
            provider: 'stripe',
            status: pi.status,
            customerId: user.stripeCustomerId,
            paymentMethodId: user.fundingPaymentMethodId,
          },
        },
      });

      return updated;
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

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        stripeAccountId: true,
        connectOnboardingCompleted: true,
      },
    });

    if (!user?.stripeAccountId) {
      return res.status(400).json({
        ok: false,
        code: 'CONNECT_ACCOUNT_REQUIRED',
        error: 'Please complete payout setup before withdrawing funds.',
      });
    }

    const acct = await getConnectAccount(user.stripeAccountId);

    if (!acct) {
      return res.status(400).json({
        ok: false,
        code: 'CONNECT_ACCOUNT_NOT_FOUND',
        error: 'Your payout account could not be found. Please restart payout setup.',
      });
    }

    if (!acct.details_submitted) {
      return res.status(400).json({
        ok: false,
        code: 'CONNECT_ONBOARDING_INCOMPLETE',
        error: 'Please finish Stripe payout onboarding before withdrawing funds.',
      });
    }

    if (!acct.payouts_enabled) {
      return res.status(400).json({
        ok: false,
        code: 'PAYOUTS_NOT_ENABLED',
        error: 'Your payout account is not ready for payouts yet. Please check your Stripe onboarding status.',
        requirements_due: acct.requirements?.currently_due || [],
      });
    }

    const wallet = await getWalletOrCreate(userId);

    if (wallet.availableCents < amountCents) {
      return res.status(400).json({
        ok: false,
        error: 'Insufficient wallet balance for withdrawal',
        availableCents: wallet.availableCents,
        requiredCents: amountCents,
      });
    }

    // Send funds from PeerFund platform balance to user's connected account.
    // Stripe IDs are stored in metadata, NOT referenceId, because referenceId is ObjectId in Prisma.
    const transfer = await stripe.transfers.create({
      amount: amountCents,
      currency: 'usd',
      destination: user.stripeAccountId,
      metadata: {
        userId,
        walletId: wallet.id,
        purpose: 'wallet_withdrawal',
      },
    });

    const updatedWallet = await prisma.$transaction(async (tx) => {
      const updated = await tx.wallet.update({
        where: { id: wallet.id },
        data: {
          availableCents: { decrement: amountCents },
        },
      });

      await tx.walletLedger.create({
        data: {
          walletId: wallet.id,
          type: 'WITHDRAWAL',
          amountCents,
          direction: 'DEBIT',
          balanceAfterCents: updated.availableCents,
          referenceType: 'StripeTransfer',
          referenceId: null,
          metadata: {
            provider: 'stripe',
            status: 'TRANSFER_CREATED',
            transferId: transfer.id,
            destinationAccountId: user.stripeAccountId,
          },
        },
      });

      return updated;
    });

    return res.json({
      ok: true,
      availableCents: updatedWallet.availableCents,
      pendingCents: updatedWallet.pendingCents,
      available: updatedWallet.availableCents / 100,
      pending: updatedWallet.pendingCents / 100,
      transferId: transfer.id,
    });
  } catch (err) {
    console.error('withdrawFunds error:', err);

    return res.status(500).json({
      ok: false,
      error:
        err?.raw?.message ||
        err?.message ||
        'Failed to withdraw funds',
    });
  }
};