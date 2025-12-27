// controllers/userController.js
const prisma = require('../utils/prisma');

/* ----------------------------- helpers ----------------------------- */

function normalizeTerms(input) {
  const out = {};
  const src = input && typeof input === 'object' ? input : {};

  for (const [rawKey, row] of Object.entries(src)) {
    const amt = Number(rawKey);
    if (!Number.isFinite(amt) || amt <= 0) continue;

    const key = String(Math.round(amt * 100) / 100); // normalize to 2-decimal string
    const enabled = !!(row && row.enabled);
    const r = Number(row && row.rate);
    const rate = Number.isFinite(r)
      ? Math.max(0, Math.min(100, Math.round(r * 100) / 100))
      : 0;

    out[key] = { enabled, rate };
  }

  return out;
}

/* ---------------- Stripe setup for SuperUser ---------------------- */

const stripeSecret = process.env.STRIPE_SECRET_KEY || '';
const SUPERUSER_PRICE_ID = process.env.STRIPE_SUPERUSER_PRICE_ID || '';

let stripe = null;
if (stripeSecret) {
  stripe = require('stripe')(stripeSecret);
} else {
  console.warn(
    '[Stripe] STRIPE_SECRET_KEY is not set – SuperUser card upgrades will not work.'
  );
}

/* ----------------------------- Profile ----------------------------- */

const getUserProfile = async (req, res) => {
  const userId = req.user.userId;
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        name: true,
        dob: true,
        location: true,
        maxLoan: true,
        summary: true,
        isSuperUser: true,
        subscriptionStatus: true,
        role: true,
        lendingTerms: true,
      },
    });
    if (!user) return res.status(404).json({ error: 'User not found' });
    return res.status(200).json(user);
  } catch (err) {
    console.error('Get profile failed:', err);
    return res.status(500).json({ error: 'Failed to fetch profile' });
  }
};

const updateUserProfile = async (req, res) => {
  const userId = req.user.userId;
  const { name, dob, location, maxLoan, summary } = req.body || {};

  const data = {};
  if (typeof name === 'string') data.name = name;
  if (typeof location === 'string') data.location = location;
  if (typeof summary === 'string') data.summary = summary;

  if (dob) {
    const d = new Date(dob);
    if (!isNaN(d.getTime())) data.dob = d;
  }
  if (maxLoan !== undefined) {
    const n = Number(maxLoan);
    if (Number.isFinite(n)) data.maxLoan = n;
  }

  try {
    const updated = await prisma.user.update({ where: { id: userId }, data });
    return res.status(200).json(updated);
  } catch (err) {
    console.error('❌ Error updating user profile:', err);
    return res.status(500).json({ error: 'Failed to update profile' });
  }
};

const getUserName = async (req, res) => {
  const userId = req.user.userId;
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { name: true },
    });
    if (!user) return res.status(404).json({ error: 'User not found' });
    return res.status(200).json({ name: user.name });
  } catch (err) {
    console.error('Get user name failed:', err);
    return res.status(500).json({ error: 'Failed to fetch name' });
  }
};

const addPhoneNumber = async (req, res) => {
  const userId = req.user.userId;
  const { phone } = req.body || {};
  if (!phone) return res.status(400).json({ error: 'Phone is required' });

  try {
    await prisma.user.update({ where: { id: userId }, data: { phone } });
    return res.status(200).json({ message: 'Phone number added successfully' });
  } catch (err) {
    console.error('Error adding phone number:', err);
    return res.status(500).json({ error: 'Could not add phone number' });
  }
};

/* ---------------- SuperUser upgrade via Stripe (card) ------------- */

const upgradeToSuperUser = async (req, res) => {
  const userId = req.user.userId;

  try {
    // Basic config validation
    if (!stripe) {
      console.error('[SuperUser] Stripe client not initialised – missing STRIPE_SECRET_KEY');
      return res
        .status(500)
        .json({ error: 'Stripe is not configured on the server. Please contact support.' });
    }

    if (!SUPERUSER_PRICE_ID) {
      console.error('[SuperUser] STRIPE_SUPERUSER_PRICE_ID is not set in env');
      return res
        .status(500)
        .json({ error: 'SuperUser price is not configured on the server.' });
    }

    // NOTE: only selecting fields that actually exist on User
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        stripeCustomerId: true,
        fundingPaymentMethodId: true, // your saved Stripe payment method
        isSuperUser: true,
        subscriptionStatus: true,
      },
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Safety check – backend agrees there is a funding card
    if (!user.fundingPaymentMethodId) {
      return res
        .status(400)
        .json({ error: 'No funding card on file. Please add one in your Wallet first.' });
    }

    // If they are already a SuperUser, short-circuit
    if (user.isSuperUser && user.subscriptionStatus === 'ACTIVE') {
      return res.json({ ok: true, alreadySuperUser: true });
    }

    // Ensure Stripe customer exists
    let customerId = user.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email || undefined,
        metadata: { userId },
      });
      customerId = customer.id;

      await prisma.user.update({
        where: { id: userId },
        data: { stripeCustomerId: customerId },
      });
    }

    // Create subscription - Stripe will auto-bill monthly
const subscription = await stripe.subscriptions.create({
  customer: customerId,
  items: [{ price: SUPERUSER_PRICE_ID }],
  default_payment_method: user.fundingPaymentMethodId,
  expand: ['latest_invoice.payment_intent'],
});

// Update user + log a transaction
await prisma.$transaction(async (tx) => {
  await tx.user.update({
    where: { id: userId },
    data: {
      isSuperUser: true,
      subscriptionStatus: 'ACTIVE',
      superUserSince: new Date(),
    },
  });

  // Log in transaction history (same pattern as wallet upgrade)
  await tx.transaction.create({
    data: {
      type: 'SUPERUSER_SUBSCRIPTION',
      amount: 1.0,        // $1.00 subscription
      fromUserId: userId, // charged user
    },
  });
});

    return res.json({ ok: true, subscriptionId: subscription.id });
  } catch (error) {
    console.error('UpgradeToSuperUser error:', {
      message: error.message,
      type: error.type,
      code: error.code,
      raw: error.raw,
    });

    const msg =
      error?.raw?.message ||
      error?.message ||
      'Failed to upgrade user. Please try again or contact support.';

    return res.status(500).json({ error: msg });
  }
};

/**
 * Upgrade to SuperUser by charging $1 from the user's PeerFund wallet.
 */
const upgradeSuperuserFromWallet = async (req, res) => {
  const userId = req.user.userId;
  const SUBSCRIPTION_CENTS = 100; // $1.00

  try {
    const result = await prisma.$transaction(async (tx) => {
      // 1) Get or create wallet for this user
      let wallet = await tx.wallet.findUnique({
        where: { userId },
      });

      if (!wallet) {
        wallet = await tx.wallet.create({
          data: {
            userId,
            availableCents: 0,
            pendingCents: 0,
            lockedCents: 0,
          },
        });
      }

      // 2) Check wallet balance
      if (wallet.availableCents < SUBSCRIPTION_CENTS) {
        const err = new Error('INSUFFICIENT_FUNDS');
        err.code = 'INSUFFICIENT_FUNDS';
        throw err;
      }

      // 3) Deduct $1 from wallet
      const updatedWallet = await tx.wallet.update({
        where: { id: wallet.id },
        data: {
          availableCents: wallet.availableCents - SUBSCRIPTION_CENTS,
        },
      });

      // 4) Flag user as SuperUser
      const updatedUser = await tx.user.update({
        where: { id: userId },
        data: {
          isSuperUser: true,
          superUserSince: new Date(),
          subscriptionStatus: 'ACTIVE',
        },
      });

      // 5) Log a transaction (simple, wallet-based)
      await tx.transaction.create({
        data: {
          type: 'SUPERUSER_SUBSCRIPTION',
          amount: SUBSCRIPTION_CENTS / 100, // store in dollars
          fromUserId: userId,
        },
      });

      return { wallet: updatedWallet, user: updatedUser };
    });

    return res.json({
      ok: true,
      message: 'Upgraded to SuperUser using your PeerFund wallet.',
      user: { isSuperUser: result.user.isSuperUser },
      wallet: { availableCents: result.wallet.availableCents },
    });
  } catch (err) {
    if (err.code === 'INSUFFICIENT_FUNDS') {
      return res.status(400).json({
        error:
          'Not enough balance in your PeerFund wallet to upgrade. Please add funds and try again.',
      });
    }

    console.error('SuperUser wallet-upgrade error:', err);
    return res.status(500).json({ error: 'Failed to upgrade to SuperUser.' });
  }
};

/* ----------------------- Public profile by ID ---------------------- */

const getPublicUserProfileById = async (req, res) => {
  const { id } = req.params;
  try {
    const user = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        summary: true,
        createdAt: true,
        isSuperUser: true,
        location: true,
        lendingTerms: true,
      },
    });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const terms = normalizeTerms(user.lendingTerms || {});

    const [givenAgg, receivedAgg, openRequestsCount] = await Promise.all([
      prisma.loan.aggregate({
        where: { lenderId: id },
        _count: true,
        _sum: { amount: true },
      }),
      prisma.loan.aggregate({
        where: { borrowerId: id },
        _count: true,
        _sum: { amount: true },
      }),
      prisma.loanRequest.count({ where: { borrowerId: id, status: 'OPEN' } }),
    ]);

    return res.json({
      id: user.id,
      name: user.name,
      summary: user.summary || '',
      signupDate: user.createdAt,
      isSuperUser: !!user.isSuperUser,
      location: user.location || null,
      lendingTerms: terms,
      stats: {
        loansGivenCount: givenAgg._count || 0,
        totalLent: Number(givenAgg._sum.amount || 0),
        loansReceivedCount: receivedAgg._count || 0,
        totalBorrowed: Number(receivedAgg._sum.amount || 0),
        openRequestsCount,
      },
      lastActiveAt: user.createdAt,
    });
  } catch (err) {
    console.error('getPublicUserProfileById error:', err);
    return res.status(500).json({ error: 'Failed to fetch profile' });
  }
};

/* ------------------------- Lending terms API ----------------------- */

const getLendingTerms = async (req, res) => {
  try {
    const userId = req.user.userId;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { lendingTerms: true },
    });
    const defaults = normalizeTerms(user?.lendingTerms || {});
    return res.json({ lendingTerms: defaults });
  } catch (e) {
    console.error('getLendingTerms error:', e);
    return res.status(500).json({ error: 'Failed to load lending terms' });
  }
};

const updateLendingTerms = async (req, res) => {
  try {
    const userId = req.user.userId;
    const incoming = req.body?.lendingTerms || {};
    const normalized = normalizeTerms(incoming);

    await prisma.user.update({
      where: { id: userId },
      data: { lendingTerms: normalized },
      select: { id: true },
    });

    return res.json({ ok: true, lendingTerms: normalized });
  } catch (e) {
    console.error('updateLendingTerms error:', e);
    return res.status(500).json({ error: 'Failed to save lending terms' });
  }
};

/* ------------------------------- Exports --------------------------- */

module.exports = {
  getUserProfile,
  updateUserProfile,
  getUserName,
  addPhoneNumber,
  upgradeToSuperUser,           // Stripe/card path
  upgradeSuperuserFromWallet,   // Wallet-based upgrade
  getPublicUserProfileById,
  getLendingTerms,
  updateLendingTerms,
};
