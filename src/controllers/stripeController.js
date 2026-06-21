require('dotenv').config(); 
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const prisma = require('../utils/prisma');

// stripeController.js
exports.createCheckoutSession = async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [
        {
          price: 'price_1Tk7cYGtWSWdZ0gUaWDprEcB',
          quantity: 1,
        },
      ],
      success_url: 'http://localhost:3000/dashboard?superuser=success',
      cancel_url: 'http://localhost:3000/dashboard?superuser=cancel',
      customer_email: req.user.email,
      metadata: {
        userId: req.user.userId, // 👈🏽 critical line
      },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe Checkout Session Error:', err);
    res.status(500).json({ error: 'Stripe session failed' });
  }
};

exports.hasLoanPaymentMethod = async (req, res) => {
  try {
    const userId = req.user.userId;

    const savedAch = await prisma.paymentMethod.findFirst({
      where: {
        userId,
        type: 'US_BANK',
        status: 'ACTIVE',
      },
      orderBy: [
        { isDefaultCharge: 'desc' },
        { createdAt: 'desc' },
      ],
      select: {
        id: true,
        stripePaymentMethodId: true,
        bankName: true,
        last4: true,
      },
    });

    return res.json({
      hasLoanPaymentMethod: !!savedAch?.stripePaymentMethodId,
      paymentMethodType: savedAch ? 'US_BANK' : null,
      bankName: savedAch?.bankName || null,
      last4: savedAch?.last4 || null,
    });
  } catch (err) {
    console.error('hasLoanPaymentMethod error:', err);
    return res.status(500).json({ error: 'Failed to check payment method' });
  }
};