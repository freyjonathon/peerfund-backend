const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

exports.handleWebhook = async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    console.log('✅ Webhook received:', event.type); 
  } catch (err) {
    console.error('❌ Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userId = session.metadata?.userId;
    const customerEmail = session.customer_email;

    console.log(`✅ Stripe checkout completed for user: ${userId || customerEmail}`);

    try {
      const updatePayload = {
        isSuperUser: true,
        superUserSince: new Date(),
        subscriptionStatus: 'ACTIVE',
        role: 'superuser'
      };

      // Optional: Create subscription record
      if (session.subscription) {
        updatePayload.subscription = {
          create: {
            stripeSubscriptionId: session.subscription,
            status: 'active',
            startedAt: new Date()
          }
        };
      }

      // ✅ Update user based on userId (preferred) or email (fallback)
      if (userId) {
        await prisma.user.update({
          where: { id: userId },
          data: updatePayload
        });
      } else if (customerEmail) {
        await prisma.user.update({
          where: { email: customerEmail },
          data: updatePayload
        });
      } else {
        throw new Error('No valid user identifier found in session.');
      }

      console.log('🚀 SuperUser upgrade complete');
    } catch (err) {
      console.error('❌ Failed to upgrade user to SuperUser:', err.message);
      return res.status(500).send('Database update failed');
    }
  }

  res.status(200).json({ received: true });
};
