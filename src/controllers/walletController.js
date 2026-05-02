// src/controllers/walletController.js
const prisma = require('../utils/prisma');
const { getWalletOrCreate } = require('../utils/wallet');
const { getUserId } = require('../middleware/authMiddleware');
const { stripe, getConnectAccount } = require('../lib/stripeIdentities');
const {
  dollarsToCents,
  grossUpForCardDeposit,
  grossUpForAchDeposit,
} = require('../utils/fees');

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
 * POST /api/wallet/webhook/stripe
 *
 * Finalizes ACH wallet deposits:
 * - payment_intent.succeeded: pendingCents -> availableCents
 * - payment_intent.payment_failed: removes pendingCents
 */
exports.stripeWebhook = async (req, res) => {
  if (!stripe) return res.status(501).send('Stripe not configured');

  const sig = req.headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;

  try {
    event = stripe.webhooks.constructEvent(req.rawBody || req.body, sig, secret);
    console.log('✅ Wallet Stripe webhook:', event.type);
  } catch (err) {
    console.error('❌ Wallet webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    const pi = event.data.object;

    if (
      event.type !== 'payment_intent.succeeded' &&
      event.type !== 'payment_intent.payment_failed'
    ) {
      return res.json({ received: true });
    }

    if (pi.metadata?.purpose !== 'wallet_deposit_ach') {
      return res.json({ received: true });
    }

    const walletId = pi.metadata?.walletId;
    const netCents = Number(pi.metadata?.netCents || 0);

    if (!walletId || !Number.isInteger(netCents) || netCents <= 0) {
      console.warn('Wallet ACH webhook missing walletId/netCents', {
        walletId,
        netCents,
        paymentIntentId: pi.id,
      });
      return res.json({ received: true });
    }

    const wallet = await prisma.wallet.findUnique({
      where: { id: walletId },
    });

    if (!wallet) {
      console.warn('Wallet not found for ACH webhook', { walletId, paymentIntentId: pi.id });
      return res.json({ received: true });
    }

    // Find the original pending ledger row.
    // Because metadata is Json, safest approach is to pull recent StripePI rows and filter in JS.
    const recentLedgers = await prisma.walletLedger.findMany({
      where: {
        walletId,
        type: 'DEPOSIT',
        referenceType: 'StripePI',
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    const pendingLedger = recentLedgers.find((row) => {
      const meta = row.metadata || {};
      return (
        meta.externalId === pi.id &&
        meta.method === 'ach' &&
        meta.pending === true
      );
    });

    if (!pendingLedger) {
      console.log('ACH deposit already finalized or pending ledger not found', {
        paymentIntentId: pi.id,
        walletId,
      });
      return res.json({ received: true });
    }

    if (event.type === 'payment_intent.succeeded') {
      await prisma.$transaction(async (tx) => {
        const currentWallet = await tx.wallet.findUnique({
          where: { id: walletId },
        });

        if (!currentWallet) throw new Error('Wallet disappeared during ACH settlement');

        const pendingDecrement = Math.min(currentWallet.pendingCents, netCents);
        const newAvailable = currentWallet.availableCents + netCents;

        await tx.wallet.update({
          where: { id: walletId },
          data: {
            pendingCents: { decrement: pendingDecrement },
            availableCents: { increment: netCents },
          },
        });

        await tx.walletLedger.update({
          where: { id: pendingLedger.id },
          data: {
            balanceAfterCents: newAvailable,
            metadata: {
              ...(pendingLedger.metadata || {}),
              pending: false,
              status: 'ACH_SETTLED',
              settledAt: new Date().toISOString(),
              stripeStatus: pi.status,
            },
          },
        });
      });

      console.log('✅ ACH wallet deposit settled', {
        paymentIntentId: pi.id,
        walletId,
        netCents,
      });
    }

    if (event.type === 'payment_intent.payment_failed') {
      await prisma.$transaction(async (tx) => {
        const currentWallet = await tx.wallet.findUnique({
          where: { id: walletId },
        });

        if (!currentWallet) throw new Error('Wallet disappeared during ACH failure');

        const pendingDecrement = Math.min(currentWallet.pendingCents, netCents);

        await tx.wallet.update({
          where: { id: walletId },
          data: {
            pendingCents: { decrement: pendingDecrement },
          },
        });

        await tx.walletLedger.update({
          where: { id: pendingLedger.id },
          data: {
            metadata: {
              ...(pendingLedger.metadata || {}),
              pending: false,
              status: 'ACH_FAILED',
              failedAt: new Date().toISOString(),
              stripeStatus: pi.status,
              failureMessage:
                pi.last_payment_error?.message || 'ACH payment failed',
            },
          },
        });
      });

      console.log('⚠️ ACH wallet deposit failed', {
        paymentIntentId: pi.id,
        walletId,
        netCents,
      });
    }

    return res.json({ received: true });
  } catch (err) {
    console.error('❌ Wallet webhook handler error:', err);
    return res.status(500).send('Wallet webhook handler error');
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
 * Real card deposit flow:
 * - User chooses amount to add to wallet
 * - Backend grosses up charge so user pays Stripe + PeerFund deposit fees
 * - Stripe charges gross amount
 * - Wallet receives net amount only
 * - Fee breakdown is stored in ledger metadata
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

    const amountCents = dollarsToCents(dollars);
    const feeBreakdown = grossUpForCardDeposit(amountCents);

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

    // 1) Charge the saved funding card for gross amount
    const pi = await stripe.paymentIntents.create({
      amount: feeBreakdown.grossCents,
      currency: 'usd',
      customer: user.stripeCustomerId,
      payment_method: user.fundingPaymentMethodId,
      off_session: true,
      confirm: true,
      metadata: {
        userId,
        walletId: wallet.id,
        purpose: 'wallet_deposit',

        // Fee details
        netCents: String(feeBreakdown.netCents),
        grossCents: String(feeBreakdown.grossCents),
        estimatedStripeFeeCents: String(feeBreakdown.estimatedStripeFeeCents),
        peerfundFeeCents: String(feeBreakdown.peerfundFeeCents),
        totalFeeCents: String(feeBreakdown.totalFeeCents),
      },
    });

    if (pi.status !== 'succeeded') {
      return res.status(400).json({
        ok: false,
        error: `PaymentIntent not succeeded (status=${pi.status})`,
      });
    }

    // 2) Credit wallet with NET deposit amount only
    const updatedWallet = await prisma.$transaction(async (tx) => {
      const updated = await tx.wallet.update({
        where: { id: wallet.id },
        data: {
          availableCents: { increment: feeBreakdown.netCents },
        },
      });

      await tx.walletLedger.create({
        data: {
          walletId: wallet.id,
          type: 'DEPOSIT',
          amountCents: feeBreakdown.netCents,
          direction: 'CREDIT',
          balanceAfterCents: updated.availableCents,
          referenceType: 'StripePI',
          referenceId: null,
          metadata: {
            externalId: pi.id,
            provider: 'stripe',
            status: pi.status,
            customerId: user.stripeCustomerId,
            paymentMethodId: user.fundingPaymentMethodId,

            netCents: feeBreakdown.netCents,
            grossCents: feeBreakdown.grossCents,
            estimatedStripeFeeCents: feeBreakdown.estimatedStripeFeeCents,
            peerfundFeeCents: feeBreakdown.peerfundFeeCents,
            totalFeeCents: feeBreakdown.totalFeeCents,
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
      deposit: {
        netCents: feeBreakdown.netCents,
        grossCents: feeBreakdown.grossCents,
        estimatedStripeFeeCents: feeBreakdown.estimatedStripeFeeCents,
        peerfundFeeCents: feeBreakdown.peerfundFeeCents,
        totalFeeCents: feeBreakdown.totalFeeCents,
      },
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
 * POST /api/wallet/deposit-ach
 * Body: { amountDollars }
 *
 * ACH deposit flow:
 * - User chooses amount to add to wallet
 * - Backend grosses up charge so user covers ACH + PeerFund fees
 * - Stripe charges gross amount using saved ACH PaymentMethod
 * - Wallet gets NET amount in pendingCents first
 * - Webhook later moves pending -> available after payment_intent.succeeded
 */
exports.depositFromSavedAch = async (req, res) => {
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

    if (!stripe) {
      return res.status(500).json({
        ok: false,
        error: 'Stripe not configured',
      });
    }

    const netCents = dollarsToCents(dollars);
    const feeBreakdown = grossUpForAchDeposit(netCents);

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        stripeCustomerId: true,
      },
    });

    if (!user?.stripeCustomerId) {
      return res.status(400).json({
        ok: false,
        error: 'No Stripe customer found. Please save a payment method first.',
      });
    }

    const achMethod = await prisma.paymentMethod.findFirst({
      where: {
        userId,
        type: 'US_BANK',
        status: 'ACTIVE',
        isDefaultCharge: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!achMethod?.stripePaymentMethodId) {
      return res.status(400).json({
        ok: false,
        code: 'NO_SAVED_ACH',
        error: 'No saved ACH bank account found. Please link a bank account first.',
      });
    }

    const wallet = await getWalletOrCreate(userId);

    const pi = await stripe.paymentIntents.create({
      amount: feeBreakdown.grossCents,
      currency: 'usd',
      customer: user.stripeCustomerId,
      payment_method: achMethod.stripePaymentMethodId,
      payment_method_types: ['us_bank_account'],
      confirm: true,
      metadata: {
        userId,
        walletId: wallet.id,
        purpose: 'wallet_deposit_ach',
        netCents: String(feeBreakdown.netCents),
        grossCents: String(feeBreakdown.grossCents),
        estimatedAchFeeCents: String(feeBreakdown.estimatedAchFeeCents),
        peerfundFeeCents: String(feeBreakdown.peerfundFeeCents),
        totalFeeCents: String(feeBreakdown.totalFeeCents),
      },
    });

    const updatedWallet = await prisma.$transaction(async (tx) => {
      const updated = await tx.wallet.update({
        where: { id: wallet.id },
        data: {
          pendingCents: { increment: feeBreakdown.netCents },
        },
      });

      await tx.walletLedger.create({
        data: {
          walletId: wallet.id,
          type: 'DEPOSIT',
          amountCents: feeBreakdown.netCents,
          direction: 'CREDIT',
          balanceAfterCents: updated.availableCents,
          referenceType: 'StripePI',
          referenceId: null,
          metadata: {
            externalId: pi.id,
            provider: 'stripe',
            method: 'ach',
            status: pi.status,
            pending: true,
            customerId: user.stripeCustomerId,
            paymentMethodId: achMethod.stripePaymentMethodId,

            netCents: feeBreakdown.netCents,
            grossCents: feeBreakdown.grossCents,
            estimatedAchFeeCents: feeBreakdown.estimatedAchFeeCents,
            peerfundFeeCents: feeBreakdown.peerfundFeeCents,
            totalFeeCents: feeBreakdown.totalFeeCents,
          },
        },
      });

      return updated;
    });

    return res.json({
      ok: true,
      status: pi.status,
      paymentIntentId: pi.id,
      availableCents: updatedWallet.availableCents,
      pendingCents: updatedWallet.pendingCents,
      available: updatedWallet.availableCents / 100,
      pending: updatedWallet.pendingCents / 100,
      deposit: {
        method: 'ach',
        netCents: feeBreakdown.netCents,
        grossCents: feeBreakdown.grossCents,
        estimatedAchFeeCents: feeBreakdown.estimatedAchFeeCents,
        peerfundFeeCents: feeBreakdown.peerfundFeeCents,
        totalFeeCents: feeBreakdown.totalFeeCents,
      },
    });
  } catch (err) {
    console.error('depositFromSavedAch error:', err);

    return res.status(500).json({
      ok: false,
      error:
        err?.raw?.message ||
        err?.message ||
        'Failed to start ACH deposit',
    });
  }
};

/**
 * POST /api/wallet/withdraw
 * Body: { amountDollars }
 *
 * Real withdrawal flow:
 * - Requires user's Stripe Connect payout account
 * - Creates Stripe transfer from PeerFund platform to connected account
 * - Debits wallet available balance
 * - Stores Stripe transfer ID in metadata, not referenceId
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

    const amountCents = dollarsToCents(dollars);

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
        error:
          'Your payout account is not ready for payouts yet. Please check your Stripe onboarding status.',
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

    // 1) Send funds from PeerFund platform balance to user's connected account
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

    // 2) Debit wallet after Stripe transfer creation succeeds
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