// src/controllers/stripeConnectController.js
require('dotenv').config();

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const {
  stripe,
  ensureStripeCustomerFor,
  ensureConnectAccountFor,
  createConnectOnboardingLink,
  getConnectAccount,
} = require('../lib/stripeIdentities');

async function getMe(req) {
  const userId = req.user?.id || req.user?.userId;
  if (!userId) return null;
  return prisma.user.findUnique({ where: { id: userId } });
}

function firstOrigin(envVal, fallback) {
  return (envVal || fallback).split(',')[0].trim();
}

const FRONTEND_ORIGIN = firstOrigin(process.env.FRONTEND_ORIGIN, 'http://localhost:3000');
const API_ORIGIN = firstOrigin(process.env.API_ORIGIN, 'http://localhost:5050');

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

exports.ensureConnectAccount = async (req, res) => {
  try {
    const me = await getMe(req);
    if (!me) return res.status(401).json({ error: 'Unauthorized' });

    const accountId = await ensureConnectAccountFor(prisma, me);
    return res.json({ accountId });
  } catch (err) {
    const stripeMsg = err?.raw?.message || err?.message || 'Failed to ensure connect account';
    const stripeCode = err?.raw?.code || err?.code || null;
    const requestId = err?.raw?.requestId || err?.requestId || null;

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

exports.createOnboardingLink = async (req, res) => {
  try {
    const me = await getMe(req);
    if (!me) return res.status(401).json({ error: 'Unauthorized' });

    const accountId = await ensureConnectAccountFor(prisma, me);

    const refreshUrl = req.body?.refreshUrl || `${API_ORIGIN}/api/stripe/onboarding/return`;
    const returnUrl = req.body?.returnUrl || `${API_ORIGIN}/api/stripe/onboarding/return`;

    const link = await createConnectOnboardingLink(accountId, refreshUrl, returnUrl);
    return res.json({ url: link.url, accountId });
  } catch (err) {
    console.error('createOnboardingLink error', err);
    return res.status(500).json({ error: 'Failed to create onboarding link' });
  }
};

exports.getConnectAccountStatus = async (req, res) => {
  try {
    const me = await getMe(req);
    if (!me) return res.status(401).json({ error: 'Unauthorized' });
    if (!me.stripeAccountId) return res.json({ hasAccount: false });

    const acct = await getConnectAccount(me.stripeAccountId);

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

exports.handleOnboardingReturn = async (req, res) => {
  try {
    const me = await getMe(req);
    if (!me) {
      return res.redirect(`${FRONTEND_ORIGIN}/login?onboarding=unauthorized`);
    }

    if (!me.stripeAccountId) {
      return res.redirect(`${FRONTEND_ORIGIN}/wallet?onboarding=missing`);
    }

    const acct = await getConnectAccount(me.stripeAccountId);
    const done = !!acct?.details_submitted;

    if (done && !me.connectOnboardingCompleted) {
      await prisma.user.update({
        where: { id: me.id },
        data: { connectOnboardingCompleted: true },
      });
    }

    return res.redirect(`${FRONTEND_ORIGIN}/wallet?onboarding=${done ? 'ok' : 'pending'}`);
  } catch (err) {
    console.error('handleOnboardingReturn error', err);
    return res.redirect(`${FRONTEND_ORIGIN}/wallet?onboarding=error`);
  }
};

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

exports.saveAchPaymentMethod = async (req, res) => {
  try {
    const me = await getMe(req);
    if (!me) return res.status(401).json({ error: 'Unauthorized' });

    const { paymentMethodId } = req.body || {};
    if (!paymentMethodId) {
      return res.status(400).json({ error: 'Missing paymentMethodId' });
    }

    const customerId = await ensureStripeCustomerFor(prisma, me);

    let pm = await stripe.paymentMethods.retrieve(paymentMethodId);

    if (!pm || pm.type !== 'us_bank_account') {
      return res.status(400).json({ error: 'Invalid payment method type' });
    }

    if (pm.customer && pm.customer !== customerId) {
      return res.status(400).json({
        error: 'Payment method belongs to another Stripe customer',
      });
    }

    if (!pm.customer) {
      pm = await stripe.paymentMethods.attach(paymentMethodId, {
        customer: customerId,
      });
    }

    const bank = pm.us_bank_account || {};
    const last4 = bank.last4 || null;
    const bankName = bank.bank_name || null;
    const accountType = bank.account_type || null;
    const fingerprint = bank.fingerprint || null;

    await prisma.paymentMethod.updateMany({
      where: {
        userId: me.id,
        type: 'US_BANK',
        isDefaultCharge: true,
      },
      data: {
        isDefaultCharge: false,
        isDefault: false,
      },
    });

    const saved = await prisma.paymentMethod.upsert({
      where: { stripePaymentMethodId: paymentMethodId },
      update: {
        userId: me.id,
        stripeCustomerId: customerId,
        type: 'US_BANK',
        brand: bankName || 'us_bank_account',
        last4,
        bankName,
        accountType,
        bankFingerprint: fingerprint,
        status: 'ACTIVE',
        isDefaultCharge: true,
        isDefault: true,
        isForLoans: false,
      },
      create: {
        userId: me.id,
        stripePaymentMethodId: paymentMethodId,
        stripeCustomerId: customerId,
        type: 'US_BANK',
        brand: bankName || 'us_bank_account',
        last4,
        bankName,
        accountType,
        bankFingerprint: fingerprint,
        status: 'ACTIVE',
        isDefaultCharge: true,
        isDefault: true,
        isForLoans: false,
      },
    });

    return res.json({
      ok: true,
      paymentMethodId: saved.stripePaymentMethodId,
      last4: saved.last4,
      bankName: saved.bankName,
      accountType: saved.accountType,
    });
  } catch (err) {
    console.error('saveAchPaymentMethod error', err);
    return res.status(500).json({
      error: err?.raw?.message || err?.message || 'Failed to save ACH payment method',
    });
  }
};

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

exports.saveLoanPaymentMethod = async (req, res) => {
  try {
    const me = await getMe(req);
    if (!me) return res.status(401).json({ error: 'Unauthorized' });

    const { paymentMethodId } = req.body;
    if (!paymentMethodId) {
      return res.status(400).json({ error: 'Missing paymentMethodId' });
    }

    const pm = await stripe.paymentMethods.retrieve(paymentMethodId);

    if (!pm || pm.type !== 'us_bank_account') {
      return res.status(400).json({ error: 'Invalid payment method type' });
    }

    const bank = pm.us_bank_account || {};
    const last4 = bank.last4 || null;
    const bankName = bank.bank_name || null;
    const accountType = bank.account_type || null;
    const fingerprint = bank.fingerprint || null;

    await prisma.paymentMethod.updateMany({
      where: { userId: me.id, isForLoans: true },
      data: { isForLoans: false },
    });

    const saved = await prisma.paymentMethod.upsert({
      where: { stripePaymentMethodId: paymentMethodId },
      update: {
        type: 'US_BANK',
        brand: bankName || 'us_bank_account',
        last4,
        bankName,
        accountType,
        bankFingerprint: fingerprint,
        status: 'ACTIVE',
        isForLoans: true,
      },
      create: {
        userId: me.id,
        stripePaymentMethodId: paymentMethodId,
        type: 'US_BANK',
        brand: bankName || 'us_bank_account',
        last4,
        bankName,
        accountType,
        bankFingerprint: fingerprint,
        status: 'ACTIVE',
        isForLoans: true,
        isDefault: false,
        isDefaultCharge: false,
      },
    });

    return res.json({
      ok: true,
      paymentMethodId: saved.stripePaymentMethodId,
      last4: saved.last4,
      bankName: saved.bankName,
      accountType: saved.accountType,
    });
  } catch (err) {
    console.error('saveLoanPaymentMethod error', err);
    return res.status(500).json({ error: 'Failed to save payment method for loans' });
  }
};

exports.getAchPaymentMethod = async (req, res) => {
  try {
    const me = await getMe(req);
    if (!me) return res.status(401).json({ error: 'Unauthorized' });

    let pm = await prisma.paymentMethod.findFirst({
      where: {
        userId: me.id,
        status: 'ACTIVE',
        type: 'US_BANK',
        isDefaultCharge: true,
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        stripePaymentMethodId: true,
        last4: true,
        bankName: true,
        accountType: true,
        brand: true,
        isDefaultCharge: true,
        isDefault: true,
        isForLoans: true,
      },
    });

    if (!pm) {
      pm = await prisma.paymentMethod.findFirst({
        where: {
          userId: me.id,
          AND: [
            {
              OR: [
                { type: 'US_BANK' },
                { brand: 'us_bank_account' },
                { brand: { contains: 'bank', mode: 'insensitive' } },
              ],
            },
            {
              OR: [
                { status: 'ACTIVE' },
                { status: undefined },
              ],
            },
            {
              OR: [
                { isDefaultCharge: true },
                { isDefault: true },
                { isForLoans: true },
              ],
            },
          ],
        },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          stripePaymentMethodId: true,
          last4: true,
          bankName: true,
          accountType: true,
          brand: true,
          isDefaultCharge: true,
          isDefault: true,
          isForLoans: true,
        },
      });
    }

    if (!pm) {
      return res.json({
        hasAch: false,
        paymentMethod: null,
      });
    }

    return res.json({
      hasAch: true,
      paymentMethod: {
        id: pm.id,
        last4: pm.last4,
        bankName: pm.bankName || pm.brand || 'Bank account',
        accountType: pm.accountType,
      },
    });
  } catch (err) {
    console.error('getAchPaymentMethod error:', err);
    return res.status(500).json({ error: 'Failed to fetch ACH payment method' });
  }
};