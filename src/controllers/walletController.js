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

const PLATFORM_USER_ID =
  process.env.PLATFORM_FEE_USER_ID || '68f523b619356751fcb1ed4b';

async function recordDepositFeeTransactions({
  tx,
  userId,
  peerfundFeeCents = 0,
  processingFeeCents = 0,
  method = 'card',
}) {
  if (!userId || !PLATFORM_USER_ID) return;

  const rows = [];

  if (peerfundFeeCents > 0) {
    rows.push({
      type: 'PLATFORM_FEE',
      amount: peerfundFeeCents / 100,
      fromUserId: userId,
      toUserId: PLATFORM_USER_ID,
      peerfundFee: peerfundFeeCents / 100,
      bankingFee: 0,
      processedAt: new Date(),
      timestamp: new Date(),
    });
  }

  if (processingFeeCents > 0) {
    rows.push({
      type: method === 'ach' ? 'ACH_FEE_RECOVERY' : 'STRIPE_FEE_RECOVERY',
      amount: processingFeeCents / 100,
      fromUserId: userId,
      toUserId: PLATFORM_USER_ID,
      peerfundFee: 0,
      bankingFee: processingFeeCents / 100,
      processedAt: new Date(),
      timestamp: new Date(),
    });
  }

  if (rows.length) {
    await tx.transaction.createMany({ data: rows });
  }
}

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
 */
exports.stripeWebhook = async (req, res) => {
  if (!stripe) return res.status(501).send('Stripe not configured');

  const sig = req.headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.rawBody || req.body,
      sig,
      secret
    );

    console.log('✅ Wallet Stripe webhook:', event.type);
  } catch (err) {
    console.error('❌ Wallet webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    const pi = event.data.object;

    // Only care about ACH wallet deposits
    if (
      pi?.metadata?.purpose !== 'wallet_deposit_ach'
    ) {
      return res.json({ received: true });
    }

    const walletId = pi.metadata?.walletId;
    const userId = pi.metadata?.userId;

    const netCents = Number(pi.metadata?.netCents || 0);
    const peerfundFeeCents = Number(
      pi.metadata?.peerfundFeeCents || 0
    );

    const processingFeeCents = Number(
      pi.metadata?.estimatedAchFeeCents || 0
    );

    if (!walletId || !netCents) {
      console.warn('Missing wallet metadata on ACH webhook', {
        paymentIntentId: pi.id,
        walletId,
        netCents,
      });

      return res.json({ received: true });
    }

    const wallet = await prisma.wallet.findUnique({
      where: { id: walletId },
    });

    if (!wallet) {
      console.warn('Wallet not found for ACH webhook', {
        walletId,
        paymentIntentId: pi.id,
      });

      return res.json({ received: true });
    }

    // Find pending ACH ledger row
    let pendingLedger = await prisma.walletLedger.findFirst({
      where: {
        walletId,
        type: 'DEPOSIT',
        referenceType: 'StripePI',
      },
      orderBy: { createdAt: 'desc' },
    });

    // More precise match if metadata exists
    const ledgers = await prisma.walletLedger.findMany({
      where: {
        walletId,
        type: 'DEPOSIT',
        referenceType: 'StripePI',
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    const matchedLedger = ledgers.find((row) => {
      const meta = row.metadata || {};

      return (
        meta.externalId === pi.id &&
        meta.method === 'ach' &&
        meta.pending === true
      );
    });

    if (matchedLedger) {
      pendingLedger = matchedLedger;
    }

    // Fallback for old deposits missing metadata
    if (!pendingLedger) {
      pendingLedger = ledgers.find((row) => {
        const meta = row.metadata || {};

        return (
          meta.method === 'ach' &&
          meta.pending === true &&
          row.amountCents === netCents
        );
      });
    }

    if (!pendingLedger) {
      console.warn('No matching ACH pending ledger found', {
        paymentIntentId: pi.id,
        walletId,
      });

      return res.json({ received: true });
    }

    /**
     * =========================================
     * ACH SUCCEEDED
     * =========================================
     */
    if (event.type === 'payment_intent.succeeded') {
      const alreadySettled =
        pendingLedger.metadata?.status === 'ACH_SETTLED';

      if (alreadySettled) {
        console.log('ACH already settled:', pi.id);

        return res.json({ received: true });
      }

      await prisma.$transaction(async (tx) => {
        const currentWallet = await tx.wallet.findUnique({
          where: { id: walletId },
        });

        if (!currentWallet) {
          throw new Error('Wallet disappeared during settlement');
        }

        const pendingDecrement = Math.min(
          currentWallet.pendingCents,
          netCents
        );

        const newAvailable =
          currentWallet.availableCents + netCents;

        await tx.wallet.update({
          where: { id: walletId },
          data: {
            pendingCents: {
              decrement: pendingDecrement,
            },

            availableCents: {
              increment: netCents,
            },
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
              paymentIntentId: pi.id,
            },
          },
        });

        await recordDepositFeeTransactions({
          tx,
          userId,
          peerfundFeeCents,
          processingFeeCents,
          method: 'ach',
        });
      });

      console.log('✅ ACH wallet deposit settled', {
        paymentIntentId: pi.id,
        walletId,
        netCents,
      });
    }

    /**
     * =========================================
     * ACH FAILED
     * =========================================
     */
    if (event.type === 'payment_intent.payment_failed') {
      await prisma.$transaction(async (tx) => {
        const currentWallet = await tx.wallet.findUnique({
          where: { id: walletId },
        });

        if (!currentWallet) {
          throw new Error('Wallet disappeared during ACH failure');
        }

        const pendingDecrement = Math.min(
          currentWallet.pendingCents,
          netCents
        );

        await tx.wallet.update({
          where: { id: walletId },
          data: {
            pendingCents: {
              decrement: pendingDecrement,
            },
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
                pi.last_payment_error?.message ||
                'ACH payment failed',
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

    return res.status(500).send(
      'Wallet webhook handler error'
    );
  }
};

exports.devConfirmDeposit = async (_req, res) => {
  return res.status(501).json({ error: 'devConfirmDeposit is no longer used' });
};

/**
 * POST /api/wallet/deposit
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
            method: 'card',
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

      await recordDepositFeeTransactions({
        tx,
        userId,
        peerfundFeeCents: feeBreakdown.peerfundFeeCents,
        processingFeeCents: feeBreakdown.estimatedStripeFeeCents,
        method: 'card',
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

    return res.status(500).json({
      ok: false,
      error:
        err?.raw?.message ||
        err?.message ||
        'Failed to deposit from funding card',
    });
  }
};

/**
 * POST /api/wallet/deposit-ach
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
        error: 'Your payout account is not ready for payouts yet.',
        requirements_due: acct.requirements?.currently_due || [],
      });
    }

    const wallet = await getWalletOrCreate(userId);

    if (wallet.availableCents < amountCents) {
      return res.status(400).json({
        ok: false,
        code: 'INSUFFICIENT_WALLET_BALANCE',
        error: 'Insufficient PeerFund wallet balance for withdrawal.',
        walletAvailableCents: wallet.availableCents,
        requiredCents: amountCents,
      });
    }

    const stripeBalance = await stripe.balance.retrieve();

    const stripeAvailableUsdCents = (stripeBalance.available || [])
      .filter((b) => b.currency === 'usd')
      .reduce((sum, b) => sum + Number(b.amount || 0), 0);

    const stripePendingUsdCents = (stripeBalance.pending || [])
      .filter((b) => b.currency === 'usd')
      .reduce((sum, b) => sum + Number(b.amount || 0), 0);

    if (stripeAvailableUsdCents < amountCents) {
      return res.status(400).json({
        ok: false,
        code: 'INSUFFICIENT_STRIPE_AVAILABLE_BALANCE',
        error:
          'Your PeerFund wallet shows funds, but Stripe funds are not available for withdrawal yet. Please try again after the payment settles.',
        walletAvailableCents: wallet.availableCents,
        stripeAvailableCents: stripeAvailableUsdCents,
        stripePendingCents: stripePendingUsdCents,
        requiredCents: amountCents,
      });
    }

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
      const currentWallet = await tx.wallet.findUnique({
        where: { id: wallet.id },
      });

      if (!currentWallet || currentWallet.availableCents < amountCents) {
        const err = new Error('INSUFFICIENT_WALLET_BALANCE');
        err.code = 'INSUFFICIENT_WALLET_BALANCE';
        throw err;
      }

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

        // referenceId must be a Mongo ObjectId-compatible value.
        // The wallet.id is safe here; Stripe IDs belong in metadata.
        referenceType: 'Wallet',
        referenceId: wallet.id,

        metadata: {
          provider: 'stripe',
          status: 'TRANSFER_CREATED',
          stripeTransferId: transfer.id,
          destinationAccountId: user.stripeAccountId,
          stripeAvailableBeforeCents: stripeAvailableUsdCents,
          stripePendingBeforeCents: stripePendingUsdCents,
          purpose: 'wallet_withdrawal',
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
      stripeAvailableBeforeCents: stripeAvailableUsdCents,
    });
  } catch (err) {
    console.error('withdrawFunds error:', err);

    if (err.code === 'INSUFFICIENT_WALLET_BALANCE') {
      return res.status(400).json({
        ok: false,
        code: 'INSUFFICIENT_WALLET_BALANCE',
        error: 'Insufficient PeerFund wallet balance for withdrawal.',
      });
    }

    return res.status(500).json({
      ok: false,
      error:
        err?.raw?.message ||
        err?.message ||
        'Failed to withdraw funds',
    });
  }
};