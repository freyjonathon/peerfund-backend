// src/controllers/stripeConnectController.js
require('dotenv').config();

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const {
  stripe,                         // Stripe SDK (from your lib)
  ensureStripeCustomerFor,        // (prisma, user) -> customerId
  ensureConnectAccountFor,        // (prisma, user) -> accountId
  createConnectOnboardingLink,    // (accountId, refreshUrl?, returnUrl?) -> accountLinks.create(...)
  getConnectAccount,              // (accountId) -> stripe.accounts.retrieve(...)
} = require('../lib/stripeIdentities');

/* ------------------------------------------------------------------ */
/* Utility: get authenticated user + id                               */
/* ------------------------------------------------------------------ */
async function getMe(req) {
  const userId = req.user?.id || req.user?.userId;
  if (!userId) return null;
  return prisma.user.findUnique({ where: { id: userId } });
}

function firstOrigin(envVal, fallback) {
  return (envVal || fallback).split(',')[0].trim();
}

const FRONTEND_ORIGIN = firstOrigin(process.env.FRONTEND_ORIGIN, 'http://localhost:3000');
const API_ORIGIN      = firstOrigin(process.env.API_ORIGIN,      'http://localhost:5050');

/* ================================================================== */
/*  Customers (borrower ACH debits; wallet deposits)                   */
/* ================================================================== */

/**
 * POST /api/stripe/ensure-customer
 * Ensures the authenticated user has a Stripe Customer (for ACH debits etc).
 */
exports.ensureCustomer = async (req, res) => {
  try {
    const me = await getMe(req);
    if (!me) return res.status(401).json({ error: 'Unauthorized' });

    const customerId = await ensureStripeCustomerFor(prisma, me);
    return res.json({ customerId });
  } catch (err) {
    console.error('ensureCustomer error', err);
    return res.status(500).json({ error: 'Failed to ensure customer' });
  }
};

/* ================================================================== */
/*  Connect (payouts)                                                  */
/* ================================================================== */

/**
 * POST /api/stripe/ensure-connect-account
 * Ensures the authenticated user has a Connect Express account.
 */
exports.ensureConnectAccount = async (req, res) => {
  try {
    const me = await getMe(req);
    if (!me) return res.status(401).json({ error: 'Unauthorized' });

    const accountId = await ensureConnectAccountFor(prisma, me);
    return res.json({ accountId });
  } catch (err) {
    const stripeMsg  = err?.raw?.message || err?.message || 'Failed to ensure connect account';
    const stripeCode = err?.raw?.code || err?.code || null;
    const requestId  = err?.raw?.requestId || err?.requestId || null;

    console.error('ensureConnectAccount error', {
      message: stripeMsg,
      code: stripeCode,
      requestId,
      type: err?.type,
      stack: err?.stack,
    });

    return res.status(500).json({
      error: stripeMsg,
      code: stripeCode,
      requestId,
    });
  }
};

/**
 * POST /api/stripe/create-connect-account
 * Alias to ensure a Connect account exists; returns the accountId.
 */
exports.createConnectAccount = async (req, res) => {
  try {
    const me = await getMe(req);
    if (!me) return res.status(401).json({ error: 'Unauthorized' });

    const accountId = await ensureConnectAccountFor(prisma, me);
    return res.json({ stripeAccountId: accountId, created: !me.stripeAccountId });
  } catch (err) {
    console.error('createConnectAccount error', err);
    return res.status(500).json({ error: 'Failed to create connect account' });
  }
};

/**
 * POST /api/stripe/connect-onboarding-link
 * Body: { refreshUrl?, returnUrl? }
 * Creates an onboarding link for the user's Connect account and returns a redirect URL.
 *
 * 🔁 Option B: Stripe returns to the API route; API then redirects to frontend.
 */
exports.createOnboardingLink = async (req, res) => {
  try {
    const me = await getMe(req);
    if (!me) return res.status(401).json({ error: 'Unauthorized' });

    const accountId = await ensureConnectAccountFor(prisma, me);

    // Default: use API callback so backend can mark completion and redirect to UI
    const refreshUrl = req.body?.refreshUrl || `${API_ORIGIN}/api/stripe/onboarding/return`;
    const returnUrl  = req.body?.returnUrl  || `${API_ORIGIN}/api/stripe/onboarding/return`;

    const link = await createConnectOnboardingLink(accountId, refreshUrl, returnUrl);
    return res.json({ url: link.url, accountId });
  } catch (err) {
    console.error('createOnboardingLink error', err);
    return res.status(500).json({ error: 'Failed to create onboarding link' });
  }
};

/**
 * GET /api/stripe/connect-account
 * Returns summarized status for the user's Connect account (payouts, details_submitted).
 */
exports.getConnectAccountStatus = async (req, res) => {
  try {
    const me = await getMe(req);
    if (!me) return res.status(401).json({ error: 'Unauthorized' });
    if (!me.stripeAccountId) return res.json({ hasAccount: false });

    const acct = await getConnectAccount(me.stripeAccountId);

    // update convenience flag in DB
    const completed = !!acct?.details_submitted;
    if (me.connectOnboardingCompleted !== completed) {
      await prisma.user.update({
        where: { id: me.id },
        data: { connectOnboardingCompleted: completed },
      });
    }

    return res.json({
      hasAccount: true,
      accountId: acct.id,
      details_submitted: acct.details_submitted,
      payouts_enabled: acct.payouts_enabled,
      requirements_due: acct.requirements?.currently_due ?? [],
    });
  } catch (err) {
    console.error('getConnectAccountStatus error', err);
    return res.status(500).json({ error: 'Failed to fetch connect account' });
  }
};

/**
 * GET /api/stripe/onboarding/return
 * Stripe redirects here after onboarding. We check status and
 * immediately redirect to the frontend Payment Method page.
 */
exports.handleOnboardingReturn = async (req, res) => {
  try {
    const me = await getMe(req);
    if (!me) {
      return res.redirect(`${FRONTEND_ORIGIN}/login?onboarding=unauthorized`);
    }

    if (!me.stripeAccountId) {
      return res.redirect(`${FRONTEND_ORIGIN}/payment-method?onboarding=missing`);
    }

    const acct = await getConnectAccount(me.stripeAccountId);
    const done = !!acct?.details_submitted;

    if (done && !me.connectOnboardingCompleted) {
      await prisma.user.update({
        where: { id: me.id },
        data: { connectOnboardingCompleted: true },
      });
    }

    // Send them back to Payment Method with a status flag
    return res.redirect(`${FRONTEND_ORIGIN}/payment-method?onboarding=${done ? 'ok' : 'pending'}`);
  } catch (err) {
    console.error('handleOnboardingReturn error', err);
    return res.redirect(`${FRONTEND_ORIGIN}/payment-method?onboarding=error`);
  }
};

/* ================================================================== */
/*  Bank linking (Customer, for ACH debits / wallet deposits)          */
/* ================================================================== */

/**
 * POST /api/stripe/create-bank-setup-intent
 * Creates a SetupIntent for collecting a US bank account via Financial Connections.
 */
exports.createBankSetupIntent = async (req, res) => {
  try {
    const me = await getMe(req);
    if (!me) return res.status(401).json({ error: 'Unauthorized' });

    const customerId = await ensureStripeCustomerFor(prisma, me);

    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      payment_method_types: ['us_bank_account'],
      payment_method_options: {
        us_bank_account: {
          financial_connections: {
            permissions: ['payment_method'],
          },
        },
      },
      metadata: { appUserId: me.id },
    });

    return res.json({ client_secret: setupIntent.client_secret });
  } catch (err) {
    console.error('createBankSetupIntent error', err);
    return res.status(500).json({ error: 'Failed to create SetupIntent' });
  }
};

/* ================================================================== */
/*  Loan funding: store borrower’s receiving bank (PaymentMethod)      */
/* ================================================================== */

/**
 * GET /api/stripe/has-loan-payment-method
 * Returns { hasLoanPaymentMethod: boolean }
 */
exports.hasLoanPaymentMethod = async (req, res) => {
  try {
    const me = await getMe(req);
    if (!me) return res.status(401).json({ error: 'Unauthorized' });

    const pm = await prisma.paymentMethod.findFirst({
      where: { userId: me.id, isForLoans: true },
    });

    return res.json({ hasLoanPaymentMethod: !!pm });
  } catch (err) {
    console.error('hasLoanPaymentMethod error', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * POST /api/stripe/save-loan-payment-method
 * Body: { paymentMethodId }
 * Saves a us_bank_account PaymentMethod as the borrower’s receiving bank for loans.
 */
exports.saveLoanPaymentMethod = async (req, res) => {
  try {
    const me = await getMe(req);
    if (!me) return res.status(401).json({ error: 'Unauthorized' });

    const { paymentMethodId } = req.body;
    if (!paymentMethodId) {
      return res.status(400).json({ error: 'Missing paymentMethodId' });
    }

    // Retrieve PM from Stripe to extract brand + last4
    const pm = await stripe.paymentMethods.retrieve(paymentMethodId);

    if (!pm || pm.type !== 'us_bank_account') {
      return res.status(400).json({ error: 'Invalid payment method type' });
    }

    const last4 = pm.us_bank_account?.last4 || null;
    const brand = pm.us_bank_account?.bank_name || 'us_bank_account';

    // (Optional) clear previous “loan” PMs so only one is active
    await prisma.paymentMethod.updateMany({
      where: { userId: me.id, isForLoans: true },
      data: { isForLoans: false },
    });

    // Upsert this one
    const saved = await prisma.paymentMethod.upsert({
      where: { stripePaymentMethodId: paymentMethodId },
      update: { isForLoans: true, last4, brand },
      create: {
        userId: me.id,
        stripePaymentMethodId: paymentMethodId,
        brand,
        last4,
        isForLoans: true,
        isDefault: false, // don’t affect wallet deposits default
      },
    });

    return res.json({ ok: true, paymentMethodId: saved.stripePaymentMethodId, last4, brand });
  } catch (err) {
    console.error('saveLoanPaymentMethod error', err);
    return res.status(500).json({ error: 'Failed to save payment method for loans' });
  }
};
