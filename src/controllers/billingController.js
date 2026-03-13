// src/controllers/billingController.js
const prisma = require('../utils/prisma');
const { getUserId } = require('../middleware/authMiddleware');

const stripeSecret = process.env.STRIPE_SECRET_KEY || '';
const stripe = stripeSecret ? require('stripe')(stripeSecret) : null;

// POST /api/billing/card/setup-intent
exports.createCardSetupIntent = async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    if (!stripe) return res.status(500).json({ error: 'Stripe not configured' });

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Ensure we have a Stripe customer
    let customerId = user.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({
        metadata: { peerfundUserId: userId },
        name: user.name || undefined,
        email: user.email || undefined,
      });
      customerId = customer.id;
      await prisma.user.update({
        where: { id: userId },
        data: { stripeCustomerId: customerId },
      });
    }

    const si = await stripe.setupIntents.create({
      customer: customerId,
      payment_method_types: ['card'],
      usage: 'off_session',
    });

    return res.json({ clientSecret: si.client_secret });
  } catch (err) {
    console.error('createCardSetupIntent error:', err);
    return res.status(500).json({ error: 'Failed to create card setup intent' });
  }
};

// POST /api/billing/card/set-funding-method
// Body: { paymentMethodId }
exports.setFundingPaymentMethod = async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    if (!stripe) return res.status(500).json({ error: 'Stripe not configured' });

    const { paymentMethodId } = req.body || {};
    if (!paymentMethodId) {
      return res.status(400).json({ error: 'paymentMethodId is required' });
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (!user.stripeCustomerId) {
      return res.status(400).json({ error: 'User is missing stripeCustomerId' });
    }

    let pm = await stripe.paymentMethods.retrieve(paymentMethodId);

    // If PM is attached to another customer, block it
    if (pm.customer && pm.customer !== user.stripeCustomerId) {
      return res.status(400).json({ error: 'Payment method belongs to another customer' });
    }

    // If PM is not attached yet, attach it
    if (!pm.customer) {
      pm = await stripe.paymentMethods.attach(paymentMethodId, {
        customer: user.stripeCustomerId,
      });
    }

    // Save as default invoice payment method on Stripe customer too (optional but helpful)
    await stripe.customers.update(user.stripeCustomerId, {
      invoice_settings: {
        default_payment_method: paymentMethodId,
      },
    });

    const brand = pm.card?.brand || null;
    const last4 = pm.card?.last4 || null;

    await prisma.user.update({
      where: { id: userId },
      data: {
        fundingPaymentMethodId: paymentMethodId,
        fundingCardBrand: brand,
        fundingCardLast4: last4,
        defaultFundingCardLast4: last4,
      },
    });

    return res.json({
      ok: true,
      fundingPaymentMethodId: paymentMethodId,
      fundingCardBrand: brand,
      fundingCardLast4: last4,
    });
  } catch (err) {
    console.error('setFundingPaymentMethod error:', err);
    return res.status(500).json({ error: err?.message || 'Failed to save funding card' });
  }
};

// GET /api/billing/has-loan-payment-method
exports.hasLoanPaymentMethod = async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { fundingPaymentMethodId: true },
    });

    return res.json({
      hasLoanPaymentMethod: !!user?.fundingPaymentMethodId,
    });
  } catch (err) {
    console.error('hasLoanPaymentMethod error:', err);
    return res.status(500).json({ error: 'Failed to check payment method' });
  }
};
