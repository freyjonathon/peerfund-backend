// src/lib/stripeIdentities.js
require('dotenv').config();
const Stripe = require('stripe');

if (!process.env.STRIPE_SECRET_KEY) {
  console.warn('[stripeIdentities] STRIPE_SECRET_KEY is not set. Check your .env');
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
});

/** Normalize a user id for metadata */
const asMetaId = (id) => (id == null ? undefined : String(id));

/** Small utility: make sure a Stripe object exists, otherwise return null */
async function safeRetrieve(fn) {
  try { return await fn(); } catch (e) {
    // If the stored id was deleted or is invalid, treat as missing and let caller re-create
    if (e && (e.statusCode === 404 || e.code === 'resource_missing')) return null;
    throw e;
  }
}

/**
 * Ensure a Stripe Customer for this user (used for ACH debits, wallet, etc.)
 * – Returns the per-user customer id
 * – If the stored id is gone in Stripe, auto-recreates and updates DB
 */
async function ensureStripeCustomerFor(prisma, user) {
  if (!user?.id) throw new Error('ensureStripeCustomerFor: missing user');

  if (user.stripeCustomerId) {
    const existing = await safeRetrieve(() => stripe.customers.retrieve(user.stripeCustomerId));
    if (existing) return existing.id;
  }

  const customer = await stripe.customers.create({
    email: user.email || undefined,
    name: user.name || undefined,
    metadata: { appUserId: asMetaId(user.id) },
  });

  await prisma.user.update({
    where: { id: user.id },
    data: { stripeCustomerId: customer.id },
  });

  return customer.id;
}

/**
 * Ensure a Stripe Connect Express account for this user (loan payouts).
 * – Returns the per-user account id
 * – If the stored id is gone in Stripe, auto-recreates and updates DB
 */
async function ensureConnectAccountFor(prisma, user) {
  if (!user?.id) throw new Error('ensureConnectAccountFor: missing user');

  if (user.stripeAccountId) {
    const existing = await safeRetrieve(() => stripe.accounts.retrieve(user.stripeAccountId));
    if (existing) return existing.id;
  }

  const account = await stripe.accounts.create({
    type: 'express',
    country: 'US',
    email: user.email || undefined,
    business_type: 'individual',
    // For your flow, transfers are required (payouts). Card payments not required on connected acct.
    capabilities: {
      transfers: { requested: true },
    },
    metadata: { appUserId: asMetaId(user.id) },
  });

  await prisma.user.update({
    where: { id: user.id },
    data: { stripeAccountId: account.id },
  });

  return account.id;
}

/**
 * Create onboarding link for a Connect account.
 */
async function createConnectOnboardingLink(accountId, refreshUrl, returnUrl) {
  const FRONTEND_ORIGIN = (process.env.FRONTEND_ORIGIN || 'http://localhost:3000')
    .split(',')[0].trim();

  return stripe.accountLinks.create({
    account: accountId,
    refresh_url: refreshUrl || `${FRONTEND_ORIGIN}/payment-method`,
    return_url:  returnUrl  || `${FRONTEND_ORIGIN}/payment-method`,
    type: 'account_onboarding',
  });
}

/** Retrieve a Connect account (null if missing) */
async function getConnectAccount(accountId) {
  return safeRetrieve(() => stripe.accounts.retrieve(accountId));
}

/**
 * Helper (optional but recommended):
 * Verify a PaymentMethod belongs to this user's Customer.
 * Returns the PaymentMethod object if OK; throws otherwise.
 */
async function assertPmBelongsToCustomer(paymentMethodId, customerId) {
  const pm = await stripe.paymentMethods.retrieve(paymentMethodId);
  // If Stripe already attached PM to a different customer, block it.
  if (pm.customer && customerId && pm.customer !== customerId) {
    const err = new Error('PaymentMethod does not belong to this user');
    err.code = 'PM_FOREIGN_CUSTOMER';
    throw err;
  }
  return pm;
}

module.exports = {
  stripe,
  ensureStripeCustomerFor,
  ensureConnectAccountFor,
  createConnectOnboardingLink,
  getConnectAccount,
  assertPmBelongsToCustomer, // <- export helper
};
