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

    const acct = await stripe.accounts.retrieve();
    console.log('Stripe platform account:', {
      id: acct.id,
      email: acct.email,
      country: acct.country,
    });

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ error: 'User not found' });

    let customerId = user.stripeCustomerId;

    // If we already have a customer ID, verify it still exists in THIS Stripe account
    if (customerId) {
      try {
        const existingCustomer = await stripe.customers.retrieve(customerId);

        if (!existingCustomer || existingCustomer.deleted) {
          customerId = null;
        }
      } catch (err) {
        const msg = err?.raw?.message || err?.message || '';
        console.warn('Stored stripeCustomerId is invalid for current Stripe account:', {
          userId,
          customerId,
          message: msg,
        });
        customerId = null;
      }
    }

    // Create a fresh Stripe customer if needed
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

      console.log('Stripe customer created/refreshed:', {
        userId,
        customerId,
      });
    } else {
      console.log('Using existing Stripe customer:', {
        userId,
        customerId,
      });
    }

    const si = await stripe.setupIntents.create({
      customer: customerId,
      payment_method_types: ['card'],
      usage: 'off_session',
    });

    console.log('SetupIntent created:', {
      id: si.id,
      livemode: si.livemode,
      customer: si.customer,
      status: si.status,
    });

    return res.json({ clientSecret: si.client_secret });
  } catch (err) {
    console.error('createCardSetupIntent error:', err);
    return res.status(500).json({ error: err?.raw?.message || err?.message || 'Failed to create card setup intent' });
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

    if (pm.customer && pm.customer !== user.stripeCustomerId) {
      return res.status(400).json({ error: 'Payment method belongs to another customer' });
    }

    if (!pm.customer) {
      pm = await stripe.paymentMethods.attach(paymentMethodId, {
        customer: user.stripeCustomerId,
      });
    }

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

    console.log('Funding payment method saved:', {
      userId,
      paymentMethodId,
      customerId: user.stripeCustomerId,
      brand,
      last4,
    });

    return res.json({
      ok: true,
      fundingPaymentMethodId: paymentMethodId,
      fundingCardBrand: brand,
      fundingCardLast4: last4,
    });
  } catch (err) {
    console.error('setFundingPaymentMethod error:', err);
    return res.status(500).json({ error: err?.raw?.message || err?.message || 'Failed to save funding card' });
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