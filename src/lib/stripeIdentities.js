// src/lib/stripeIdentities.js
require('dotenv').config();
const Stripe = require('stripe');

/**
 * Stripe environment selection
 *
 * Recommended env vars:
 *  - STRIPE_MODE=live   (or test)
 *  - STRIPE_SECRET_KEY_LIVE=sk_live_...
 *  - STRIPE_SECRET_KEY_TEST=sk_test_...
 *
 * Back-compat:
 *  - STRIPE_SECRET_KEY=sk_live_... (or sk_test_...)
 */
const MODE = (process.env.STRIPE_MODE || '').toLowerCase().trim(); // 'live' | 'test' | ''
const isProd = process.env.NODE_ENV === 'production';

function pickSecretKey() {
  // Preferred: dual key setup
  if (MODE === 'live' && process.env.STRIPE_SECRET_KEY_LIVE) return process.env.STRIPE_SECRET_KEY_LIVE;
  if (MODE === 'test' && process.env.STRIPE_SECRET_KEY_TEST) return process.env.STRIPE_SECRET_KEY_TEST;

  // Fallback: single key setup (your current approach)
  if (process.env.STRIPE_SECRET_KEY) return process.env.STRIPE_SECRET_KEY;

  return '';
}

const STRIPE_SECRET = (pickSecretKey() || '').trim();

if (!STRIPE_SECRET) {
  console.warn('[stripeIdentities] No Stripe secret key found. Set STRIPE_SECRET_KEY (or *_LIVE/*_TEST + STRIPE_MODE).');
}

// Safety: never allow test keys in production
if (isProd && STRIPE_SECRET.startsWith('sk_test_')) {
  throw new Error(
    '[stripeIdentities] Refusing to start: STRIPE_SECRET is sk_test_ in production. Set a sk_live_ key.'
  );
}

const stripe = new Stripe(STRIPE_SECRET, {
  apiVersion: '2024-06-20',
});

// Helpful one-time boot log
const keyType = STRIPE_SECRET.startsWith('sk_live_')
  ? 'LIVE'
  : STRIPE_SECRET.startsWith('sk_test_')
  ? 'TEST'
  : 'MISSING/UNKNOWN';

console.log(`[stripeIdentities] Stripe key type: ${keyType}${MODE ? ` | STRIPE_MODE=${MODE}` : ''}`);

/** Normalize a user id for metadata */
const asMetaId = (id) => (id == null ? undefined : String(id));

/** Small utility: make sure a Stripe object exists, otherwise return null */
async function safeRetrieve(fn) {
  try {
    return await fn();
  } catch (e) {
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
    const existing = await safeRetrieve(() =>
      stripe.customers.retrieve(user.stripeCustomerId)
    );
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
    const existing = await safeRetrieve(() =>
      stripe.accounts.retrieve(user.stripeAccountId)
    );
    if (existing) return existing.id;
  }

  const account = await stripe.accounts.create({
    type: 'express',
    country: 'US',
    email: user.email || undefined,
    business_type: 'individual',
    capabilities: {
      transfers: { requested: true },
      card_payments: { requested: true}
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
    .split(',')[0]
    .trim();

  return stripe.accountLinks.create({
    account: accountId,
    refresh_url: refreshUrl || `${FRONTEND_ORIGIN}/payment-method`,
    return_url: returnUrl || `${FRONTEND_ORIGIN}/payment-method`,
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
  assertPmBelongsToCustomer,
};
