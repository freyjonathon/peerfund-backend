// controllers/paymentsController.js
const Stripe = require('stripe');
const prisma = require('../utils/prisma');

if (!process.env.STRIPE_SECRET_KEY) {
  console.warn('⚠️ STRIPE_SECRET_KEY is not set. Stripe calls will fail.');
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
});

/* ----------------------------- helpers ----------------------------- */

// Ensure a Stripe customer exists for this (tenant, user) pair.
// Note: stripeCustomerId stays on User; we validate tenant match via DB queries.
async function ensureStripeCustomer(userId, tenantId) { // 🟦 tenant-aware
  const user = await prisma.user.findFirst({
    where: { id: userId, tenantId }, // 🟦
    select: { id: true, name: true, email: true, stripeCustomerId: true },
  });
  if (!user) throw new Error('User not found for this tenant');

  if (user.stripeCustomerId) return user.stripeCustomerId;

  const customer = await stripe.customers.create({
    name: user.name || undefined,
    email: user.email || undefined,
    metadata: {
      appUserId: String(user.id),
      tenantId: String(tenantId), // 🟦 helpful to trace in Stripe
    },
  });

  await prisma.user.update({
    where: { id: user.id },
    data: { stripeCustomerId: customer.id },
  });

  return customer.id;
}

/* ----------------------------- controllers ----------------------------- */

// GET /api/payments/has-default-payment-method
exports.hasDefaultPaymentMethod = async (req, res) => {
  try {
    const userId = req.user?.userId;
    const tenantId = req.tenant?.id;               // 🟦
    if (!userId || !tenantId) {
      return res.status(200).json({ hasDefault: false });
    }

    const pm = await prisma.paymentMethod.findFirst({
      where: { tenantId, userId, isDefault: true }, // 🟦
      select: { id: true },
    });

    return res.json({ hasDefault: !!pm });
  } catch (err) {
    console.error('has-default-payment-method error:', err);
    return res.status(200).json({ hasDefault: false });
  }
};

// POST /api/payments/create-setup-intent
// Starts Financial Connections flow to link a US bank account
exports.createSetupIntent = async (req, res) => {
  try {
    const userId = req.user?.userId;
    const tenantId = req.tenant?.id;                  // 🟦
    if (!userId || !tenantId) return res.status(401).json({ error: 'Unauthorized' });

    const customerId = await ensureStripeCustomer(userId, tenantId); // 🟦

    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      usage: 'off_session',
      payment_method_types: ['us_bank_account'],
      payment_method_options: {
        us_bank_account: {
          financial_connections: {
            permissions: ['payment_method'],
          },
        },
      },
    });

    console.log('🧾 SetupIntent created:', setupIntent.id, 'livemode=', setupIntent.livemode);
    return res.json({ clientSecret: setupIntent.client_secret });
  } catch (err) {
    console.error('create-setup-intent error:', err);
    return res.status(500).json({ error: 'Failed to create setup intent' });
  }
};

// POST /api/payments/pay
// Charges the user's default saved bank account via ACH debit
exports.pay = async (req, res) => {
  try {
    const userId = req.user?.userId;
    const tenantId = req.tenant?.id;                    // 🟦
    if (!userId || !tenantId) return res.status(401).json({ error: 'Unauthorized' });

    const { amountInCents, currency = 'usd', description } = req.body || {};
    if (!Number.isInteger(amountInCents) || amountInCents <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    const user = await prisma.user.findFirst({         // 🟦 scope by tenant
      where: { id: userId, tenantId },
      select: { id: true, stripeCustomerId: true },
    });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const customerId = user.stripeCustomerId || (await ensureStripeCustomer(userId, tenantId)); // 🟦

    const defaultPm = await prisma.paymentMethod.findFirst({
      where: { tenantId, userId, isDefault: true },    // 🟦
    });
    if (!defaultPm) {
      return res.status(400).json({ error: 'NO_STRIPE_PAYMENT_INFO' });
    }

    const pi = await stripe.paymentIntents.create({
      amount: amountInCents,
      currency,
      customer: customerId,
      payment_method: defaultPm.stripePaymentMethodId,
      confirm: true,
      off_session: true,
      payment_method_types: ['us_bank_account'],
      description,
    });

    return res.json({ id: pi.id, status: pi.status, next_action: pi.next_action || null });
  } catch (err) {
    console.error('pay error:', err);
    return res.status(400).json({ error: err?.message || 'Payment failed' });
  }
};

// POST /api/payments/webhook   (mounted with express.raw in server.js)
// Persists the payment method when the setup completes
exports.webhook = async (req, res) => {
  let event;
  try {
    const sig = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(
      req.body, // raw body
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'setup_intent.succeeded': {
        const si = event.data.object;
        const customerId = si.customer;
        const paymentMethodId = si.payment_method;

        // Find our app user by Stripe customer (gives us tenantId too)
        const user = await prisma.user.findFirst({
          where: { stripeCustomerId: customerId },
          select: { id: true, tenantId: true }, // 🟦
        });
        if (!user) break;
        const tenantId = user.tenantId;         // 🟦 derive tenant for webhook

        // Fetch PM details for display (brand/last4/bank)
        const pm = await stripe.paymentMethods.retrieve(paymentMethodId);
        const brand = pm?.type || 'us_bank_account';
        const last4 =
          pm?.us_bank_account?.last4 ??
          pm?.card?.last4 ??
          null;
        const bankName = pm?.us_bank_account?.bank_name || null;
        const routingLast4 = pm?.us_bank_account?.routing_number
          ? String(pm.us_bank_account.routing_number).slice(-4)
          : null;

        // Clear existing defaults for this user in this tenant, then upsert the new default
        await prisma.paymentMethod.updateMany({
          where: { tenantId, userId: user.id, isDefault: true }, // 🟦
          data: { isDefault: false },
        });

        await prisma.paymentMethod.upsert({
          where: { stripePaymentMethodId: paymentMethodId }, // unique in DB
          update: {
            tenantId,              // 🟦 ensure set
            userId: user.id,
            isDefault: true,
            brand,
            last4,
            bankName,
            routingLast4,
          },
          create: {
            tenantId,              // 🟦
            userId: user.id,
            stripePaymentMethodId: paymentMethodId,
            brand,
            last4,
            bankName,
            routingLast4,
            isDefault: true,
          },
        });

        console.log('✅ Saved default bank PM for user', user.id, paymentMethodId, 'tenant', tenantId);
        break;
      }

      case 'payment_intent.succeeded':
        // Optional: add ledger entries keyed by tenantId (from related loan/repayment lookups)
        break;

      case 'payment_intent.payment_failed':
        // Optional: record failure reason
        break;

      default:
        // ignore other events
        break;
    }

    return res.json({ received: true });
  } catch (err) {
    console.error('Webhook handler error:', err);
    return res.status(500).json({ error: 'Webhook handling error' });
  }
};

/* -------------------------- diagnostics ----------------------------- */
// GET /api/payments/_debug/stripe
exports.stripeDebug = async (_req, res) => {
  try {
    const acct = await stripe.accounts.retrieve();
    return res.json({ account: acct.id, livemode: acct.livemode });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};

// POST /api/payments/save-default-from-stripe
// Body: { pmId: "pm_..." }
// Auth: Bearer token (req.user.userId must be set)
exports.saveDefaultFromStripe = async (req, res) => {
  try {
    const userId = req.user?.userId;
    const tenantId = req.tenant?.id;                 // 🟦
    if (!userId || !tenantId) return res.status(401).json({ error: 'Unauthorized' });

    const pmId = (req.body?.pmId || '').trim();
    if (!pmId.startsWith('pm_')) {
      return res.status(400).json({ error: 'Missing or invalid pmId' });
    }

    // Ensure (tenant,user) exists
    const user = await prisma.user.findFirst({
      where: { id: userId, tenantId },              // 🟦
      select: { id: true, name: true, email: true, stripeCustomerId: true },
    });
    if (!user) return res.status(404).json({ error: 'User not found for this tenant' });

    const customerId = user.stripeCustomerId || (await ensureStripeCustomer(userId, tenantId)); // 🟦

    // Retrieve the payment method from Stripe
    const pm = await stripe.paymentMethods.retrieve(pmId);

    // Attach to the customer if it isn't already
    if (!pm.customer) {
      await stripe.paymentMethods.attach(pmId, { customer: customerId });
    } else if (pm.customer !== customerId) {
      return res.status(400).json({ error: 'Payment method belongs to another customer' });
    }

    // (Optional) Set as default for invoices
    await stripe.customers.update(customerId, {
      invoice_settings: { default_payment_method: pmId },
    });

    const brand = pm?.type || 'us_bank_account';
    const last4 =
      pm?.us_bank_account?.last4 ??
      pm?.card?.last4 ??
      null;
    const bankName = pm?.us_bank_account?.bank_name || null;
    const routingLast4 = pm?.us_bank_account?.routing_number
      ? String(pm.us_bank_account.routing_number).slice(-4)
      : null;

    // Clear existing defaults in this tenant, then upsert this PM as default
    await prisma.paymentMethod.updateMany({
      where: { tenantId, userId, isDefault: true },  // 🟦
      data: { isDefault: false },
    });

    await prisma.paymentMethod.upsert({
      where: { stripePaymentMethodId: pmId },
      update: { tenantId, userId, brand, last4, bankName, routingLast4, isDefault: true }, // 🟦
      create: {
        tenantId, userId, stripePaymentMethodId: pmId, brand, last4, bankName, routingLast4, isDefault: true, // 🟦
      },
    });

    return res.json({ ok: true, pmId, last4, brand, bankName, routingLast4 });
  } catch (err) {
    console.error('save-default-from-stripe error:', err);
    const msg = err?.message || 'Bad Request';
    return res.status(400).json({ error: msg });
  }
};

/* ---------------------- optional: display info ---------------------- */
// GET /api/payments/default-display
exports.getDefaultDisplay = async (req, res) => {
  try {
    const userId = req.user?.userId;
    const tenantId = req.tenant?.id;                     // 🟦
    if (!userId || !tenantId) return res.status(200).json({ hasDefault: false });

    const pm = await prisma.paymentMethod.findFirst({
      where: { tenantId, userId, isDefault: true },      // 🟦
      select: { brand: true, last4: true, bankName: true, routingLast4: true },
    });

    if (!pm) return res.json({ hasDefault: false });

    return res.json({
      hasDefault: true,
      ...pm,
    });
  } catch (e) {
    console.error('getDefaultDisplay error:', e);
    return res.status(200).json({ hasDefault: false });
  }
};
