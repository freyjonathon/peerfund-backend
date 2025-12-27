// src/services/billingService.js
const prisma = require('../utils/prisma');
const stripeSecret = process.env.STRIPE_SECRET_KEY || '';
const stripe = stripeSecret ? require('stripe')(stripeSecret) : null;

async function chargeFundingCard(userId, amountCents, extraMeta = {}) {
  if (!stripe) throw new Error('Stripe not configured');

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new Error('User not found');

  if (!user.stripeCustomerId || !user.fundingPaymentMethodId) {
    throw new Error('No funding card on file');
  }

  const pi = await stripe.paymentIntents.create({
    amount: amountCents,
    currency: 'usd',
    customer: user.stripeCustomerId,
    payment_method: user.fundingPaymentMethodId,
    off_session: true,
    confirm: true,
    metadata: {
      peerfundUserId: userId,
      ...extraMeta,
    },
  });

  if (pi.status !== 'succeeded') {
    throw new Error(`PaymentIntent status ${pi.status}`);
  }

  return pi;
}

module.exports = {
  chargeFundingCard,
};
