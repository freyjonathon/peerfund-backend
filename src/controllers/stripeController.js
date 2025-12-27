require('dotenv').config(); 
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// stripeController.js
exports.createCheckoutSession = async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [
        {
          price: 'price_1RqOBUGsm03jYeOaFzalJLpS',
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
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { stripeDefaultPaymentMethodId: true },
    });

    return res.json({
      hasLoanPaymentMethod: !!user?.stripeDefaultPaymentMethodId,
    });
  } catch (err) {
    console.error('hasLoanPaymentMethod error:', err);
    return res.status(500).json({ error: 'Failed to check payment method' });
  }
};


