// src/controllers/paymentMethodController.js
require('dotenv').config();

const prisma = require('../utils/prisma');
const { stripe, ensureStripeCustomerFor } = require('../lib/stripeIdentities');

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */
function getAuthUserId(req) {
  return req.user?.id || req.user?.userId || null;
}

/* -------------------------------------------------------------------------- */
/* GET /api/payment-method/mine                                                */
/* Return all active methods for this user (default first).                    */
/* -------------------------------------------------------------------------- */
exports.getMyPaymentMethods = async (req, res) => {
  try {
    const userId = getAuthUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    console.log('[getMyPaymentMethods] userId:', userId);

    // TEMP: loosen filter to rule out archivedAt mismatch
    const rows = await prisma.paymentMethod.findMany({
      where: {
        userId, // only filter by user for now
        // remove archivedAt filter during debug
        // OR add a lenient OR if you prefer:
        // OR: [{ archivedAt: null }, { archivedAt: { equals: undefined } }],
      },
      orderBy: [{ isDefault: 'desc' }, { isForLoans: 'desc' }, { createdAt: 'desc' }],
    });

    console.log('[getMyPaymentMethods] found rows:', rows.length);

    return res.json({
      items: rows.map((r) => ({
        id: r.id,
        stripePaymentMethodId: r.stripePaymentMethodId,
        type: r.type,
        brand: r.brand,
        last4: r.last4,
        isDefault: r.isDefault,
        isForLoans: r.isForLoans,
        createdAt: r.createdAt,
      })),
    });
  } catch (err) {
    console.error('getMyPaymentMethods error:', err);
    return res.status(500).json({ error: 'Failed to load payment methods' });
  }
};

/* -------------------------------------------------------------------------- */
/* GET /api/payment-method (legacy single "current" method)                    */
/* Return the user's default method (or most recent).                          */
/* -------------------------------------------------------------------------- */
exports.getPaymentMethod = async (req, res) => {
  try {
    const userId = getAuthUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const method = await prisma.paymentMethod.findFirst({
      where: {
        userId,
        // ❗ Remove if you don't have archivedAt
        archivedAt: null,
      },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });

    if (!method) return res.status(404).json({ message: 'No payment method found.' });
    res.json(method);
  } catch (err) {
    console.error('GET /payment-method error:', err);
    res.status(500).json({ error: 'Failed to fetch payment method' });
  }
};

/* -------------------------------------------------------------------------- */
/* POST /api/payment-method/save                                               */
/* Body: { paymentMethodId, makeDefault?: boolean, useForLoans?: boolean }     */
/* Assumes frontend already completed a SetupIntent and has pm_xxx id.         */
/* -------------------------------------------------------------------------- */
exports.savePaymentMethod = async (req, res) => {
  try {
    const userId = getAuthUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { paymentMethodId, makeDefault = true, useForLoans = false } = req.body || {};
    if (!paymentMethodId) {
      return res.status(400).json({ error: 'Missing paymentMethodId' });
    }

    const me = await prisma.user.findUnique({ where: { id: userId } });
    if (!me) return res.status(404).json({ error: 'User not found' });

    // Ensure a Stripe Customer exists for this user
    const customerId = await ensureStripeCustomerFor(prisma, me);

    // Retrieve/validate PaymentMethod from Stripe
    let pm = await stripe.paymentMethods.retrieve(paymentMethodId);
    if (!pm || pm.type !== 'us_bank_account') {
      return res.status(400).json({ error: 'Invalid payment method type (expected us_bank_account)' });
    }

    // Attach to our customer if needed (prevents cross-user reuse)
    if (!pm.customer) {
      pm = await stripe.paymentMethods.attach(paymentMethodId, { customer: customerId });
    } else if (pm.customer !== customerId) {
      return res.status(400).json({ error: 'PaymentMethod belongs to a different customer' });
    }

    const last4 = pm.us_bank_account?.last4 || null;
    const brand = pm.us_bank_account?.bank_name || 'us_bank_account';
    // ❗ If you DON'T have bankFingerprint in schema, remove next line.
    const bankFingerprint = pm.us_bank_account?.fingerprint || null;

    // Clear other defaults/loan flags for this user if toggling
    if (makeDefault) {
      await prisma.paymentMethod.updateMany({
        where: {
          userId: me.id,
          isDefault: true,
          // ❗ Remove archivedAt condition if not in schema
          archivedAt: null,
        },
        data: { isDefault: false },
      });
    }
    if (useForLoans) {
      await prisma.paymentMethod.updateMany({
        where: {
          userId: me.id,
          isForLoans: true,
          // ❗ Remove archivedAt condition if not in schema
          archivedAt: null,
        },
        data: { isForLoans: false },
      });
    }

    // Upsert by UNIQUE field: stripePaymentMethodId
    const saved = await prisma.paymentMethod.upsert({
      where: { stripePaymentMethodId: paymentMethodId },
      update: {
        userId: me.id,
        // ❗ If you DON'T have stripeCustomerId/type/bankFingerprint/archivedAt, remove them.
        stripeCustomerId: customerId,
        type: 'US_BANK',
        brand,
        last4,
        bankFingerprint,
        isDefault: !!makeDefault,
        isForLoans: !!useForLoans,
        archivedAt: null,
      },
      create: {
        userId: me.id,
        stripePaymentMethodId: paymentMethodId,
        stripeCustomerId: customerId, // ❗ remove if not in schema
        type: 'US_BANK',              // ❗ remove if not in schema
        brand,
        last4,
        bankFingerprint,              // ❗ remove if not in schema
        isDefault: !!makeDefault,
        isForLoans: !!useForLoans,
      },
      include: { user: true },
    });

    // Convenience mirrors on User
    const userPatch = {};
    if (makeDefault) userPatch.defaultDebitBankLast4 = last4 || null;
    if (useForLoans) userPatch.defaultPayoutBankLast4 = last4 || null;
    if (Object.keys(userPatch).length) {
      await prisma.user.update({ where: { id: me.id }, data: userPatch });
    }

    return res.json({
      ok: true,
      paymentMethod: {
        id: saved.id,
        stripePaymentMethodId: saved.stripePaymentMethodId,
        brand: saved.brand,
        last4: saved.last4,
        isDefault: saved.isDefault,
        isForLoans: saved.isForLoans,
      },
    });
  } catch (err) {
    console.error('savePaymentMethod error:', err);
    const msg = err?.raw?.message || err?.message || 'Failed to save payment method';
    return res.status(500).json({ error: msg });
  }
};

/* -------------------------------------------------------------------------- */
/* POST /api/payment-method/set-default  Body: { id }                          */
/* Mark one PM as the default (wallet/repayments).                             */
/* -------------------------------------------------------------------------- */
exports.setDefaultPaymentMethod = async (req, res) => {
  try {
    const userId = getAuthUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'Missing id' });

    const pm = await prisma.paymentMethod.findUnique({ where: { id } });
    if (!pm || String(pm.userId) !== String(userId)) {
      return res.status(404).json({ error: 'Payment method not found' });
    }

    await prisma.paymentMethod.updateMany({
      where: {
        userId,
        isDefault: true,
        // ❗ Remove if you don't have archivedAt
        archivedAt: null,
      },
      data: { isDefault: false },
    });

    const updated = await prisma.paymentMethod.update({
      where: { id },
      data: { isDefault: true },
    });

    await prisma.user.update({
      where: { id: userId },
      data: { defaultDebitBankLast4: updated.last4 || null },
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error('setDefaultPaymentMethod error:', err);
    return res.status(500).json({ error: 'Failed to set default' });
  }
};

/* -------------------------------------------------------------------------- */
/* POST /api/payment-method/set-loan-bank  Body: { id }                        */
/* Mark one PM as the "loan payout destination" (isForLoans=true).            */
/* -------------------------------------------------------------------------- */
exports.setLoanReceivingBank = async (req, res) => {
  try {
    const userId = getAuthUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'Missing id' });

    const pm = await prisma.paymentMethod.findUnique({ where: { id } });
    if (!pm || String(pm.userId) !== String(userId)) {
      return res.status(404).json({ error: 'Payment method not found' });
    }

    await prisma.paymentMethod.updateMany({
      where: {
        userId,
        isForLoans: true,
        // ❗ Remove if you don't have archivedAt
        archivedAt: null,
      },
      data: { isForLoans: false },
    });

    const updated = await prisma.paymentMethod.update({
      where: { id },
      data: { isForLoans: true },
    });

    await prisma.user.update({
      where: { id: userId },
      data: { defaultPayoutBankLast4: updated.last4 || null },
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error('setLoanReceivingBank error:', err);
    return res.status(500).json({ error: 'Failed to set loan receiving bank' });
  }
};

// ---- unified export (rebinding what's on `exports.*`) ----
module.exports = {
  // implemented above
  getMyPaymentMethods: exports.getMyPaymentMethods,
  getPaymentMethod: exports.getPaymentMethod,
  savePaymentMethod: exports.savePaymentMethod,
  setDefaultPaymentMethod: exports.setDefaultPaymentMethod,
  setLoanReceivingBank: exports.setLoanReceivingBank,

  // optional placeholders: keep routes from crashing until you implement them
  attachAndSavePaymentMethod:
    (req, res) => res.status(501).json({ error: 'attachAndSavePaymentMethod not implemented' }),
  archivePaymentMethod:
    (req, res) => res.status(501).json({ error: 'archivePaymentMethod not implemented' }),
  getPublicReceivingBankMasked:
    (req, res) => res.status(501).json({ error: 'getPublicReceivingBankMasked not implemented' }),
};
