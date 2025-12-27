// src/controllers/stripeWebhookController.js
require('dotenv').config();
const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

exports.handleStripeWebhook = async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  // IMPORTANT: verify against raw body
  try {
    event = Stripe.webhooks.constructEvent(req.rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
    console.log('✅ Stripe webhook:', event.type);
  } catch (err) {
    console.error('❌ Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      /**
       * ========= Subscriptions / SuperUser (Checkout) =========
       * Your existing logic, with 2 fixes:
       *  - use req.rawBody for verification (already done)
       *  - write enum value role: 'SUPERUSER' (matches your schema)
       */
      case 'checkout.session.completed': {
        const session = event.data.object;
        const userId = session.metadata?.userId;
        const customerEmail = session.customer_email;

        console.log(`✅ checkout.session.completed for user: ${userId || customerEmail}`);

        const updatePayload = {
          isSuperUser: true,
          superUserSince: new Date(),
          subscriptionStatus: 'ACTIVE',
          role: 'SUPERUSER', // enum value in your schema
        };

        // Optional: persist subscription row if Stripe sent a subscription id
        if (session.subscription) {
          updatePayload.subscription = {
            create: {
              stripeSubscriptionId: session.subscription,
              status: 'active',
              startedAt: new Date(),
            },
          };
        }

        if (userId) {
          await prisma.user.update({ where: { id: userId }, data: updatePayload });
        } else if (customerEmail) {
          await prisma.user.update({ where: { email: customerEmail }, data: updatePayload });
        } else {
          console.warn('No userId or customer_email on checkout.session.completed');
        }

        break;
      }

      /**
       * ========= Lending / Destination Charges (ACH) =========
       */
      case 'payment_intent.processing': {
        const pi = event.data.object;
        const loanId = pi.metadata?.loanId;
        if (loanId) {
          await prisma.loan.update({
            where: { id: loanId },
            data: { status: 'PROCESSING' },
          });
        }
        break;
      }

      case 'payment_intent.succeeded': {
        // For ACH this is "submitted/confirmed" — funds not necessarily available yet.
        const pi = event.data.object;
        const loanId = pi.metadata?.loanId;
        if (loanId) {
          await prisma.loan.update({
            where: { id: loanId },
            data: { status: 'PROCESSING', chargeId: pi.latest_charge || undefined },
          });
        }
        break;
      }

      case 'payment_intent.payment_failed': {
        const pi = event.data.object;
        const loanId = pi.metadata?.loanId;
        if (loanId) {
          await prisma.loan.update({
            where: { id: loanId },
            data: { status: 'FAILED' },
          });
        }
        break;
      }

      case 'transfer.created': {
        // Triggered when Stripe auto-transfers net funds to lender's Connect account
        const tr = event.data.object;

        // Best-effort: find related loan by pulling the charge and reading metadata.loanId
        if (tr?.source_transaction) {
          try {
            const ch = await stripe.charges.retrieve(tr.source_transaction);
            const loanId = ch?.metadata?.loanId;
            if (loanId) {
              await prisma.loan.update({
                where: { id: loanId },
                data: { status: 'FUNDED', fundedDate: new Date() },
              });
            }
          } catch (e) {
            console.warn('transfer.created: could not retrieve related charge', e?.message);
          }
        }
        break;
      }

      default: {
        // No-op for other events for now
        break;
      }
    }

    return res.json({ received: true });
  } catch (err) {
    console.error('❌ Webhook handler error:', err);
    return res.status(500).send('Webhook handler error');
  }
};
