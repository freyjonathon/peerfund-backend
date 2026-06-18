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
      const pi = event.data.object;

      /**
       * Loan funding settlement:
       * Lender ACH succeeded, so now credit borrower wallet net amount.
       */
      if (pi.metadata?.purpose === 'LOAN_FUNDING') {
        const loanId = pi.metadata?.loanId;
        const borrowerId = pi.metadata?.borrowerId;
        const lenderId = pi.metadata?.lenderId;

        const principalCents = Number(pi.metadata?.principalCents || 0);
        const peerfundFeeCents = Number(pi.metadata?.peerfundFeeCents || 0);
        const bankingFeeCents = Number(pi.metadata?.bankingFeeCents || 0);
        const netDisbursementCents = Number(pi.metadata?.netDisbursementCents || 0);

        if (!loanId || !borrowerId || !lenderId || !netDisbursementCents) {
          console.warn('LOAN_FUNDING succeeded but missing metadata:', {
            paymentIntentId: pi.id,
            metadata: pi.metadata,
          });
          break;
        }

        const existingLedger = await prisma.walletLedger.findFirst({
          where: {
            referenceType: 'Loan',
            referenceId: loanId,
            type: 'DISBURSE',
          },
        });

        if (existingLedger) {
          console.log('Loan funding already settled:', {
            loanId,
            paymentIntentId: pi.id,
          });
          break;
        }

        await prisma.$transaction(async (tx) => {
          const borrowerWallet = await tx.wallet.upsert({
            where: { userId: borrowerId },
            update: {},
            create: {
              userId: borrowerId,
              availableCents: 0,
              pendingCents: 0,
            },
          });

          const updatedWallet = await tx.wallet.update({
            where: { id: borrowerWallet.id },
            data: {
              availableCents: {
                increment: netDisbursementCents,
              },
            },
          });

          await tx.walletLedger.create({
            data: {
              walletId: borrowerWallet.id,
              type: 'DISBURSE',
              amountCents: netDisbursementCents,
              direction: 'CREDIT',
              balanceAfterCents: updatedWallet.availableCents,
              referenceType: 'Loan',
              referenceId: loanId,
              metadata: {
                reason: 'LOAN_FUNDING_SETTLED',
                stripePaymentIntentId: pi.id,
                stripeStatus: pi.status,
                loanId,
                borrowerId,
                lenderId,
                principalCents,
                peerfundFeeCents,
                bankingFeeCents,
                netDisbursementCents,
              },
            },
          });

          await tx.loan.update({
            where: { id: loanId },
            data: {
              status: 'FUNDED',
              disbursedAmount: netDisbursementCents / 100,
              chargeId: pi.latest_charge || undefined,
              updatedAt: new Date(),
            },
          });

          await tx.transaction.create({
            data: {
              type: 'DISBURSEMENT',
              amount: netDisbursementCents / 100,
              loanId,
              fromUserId: lenderId,
              toUserId: borrowerId,
              processedAt: new Date(),
              timestamp: new Date(),
            },
          });

          await tx.notification.create({
            data: {
              userId: borrowerId,
              type: 'WALLET',
              message: `💸 Your loan has been funded. $${(
                netDisbursementCents / 100
              ).toFixed(2)} is now available in your PeerFund wallet.`,
              data: {
                loanId,
                lenderId,
                grossAmountCents: principalCents,
                peerfundFeeCents,
                bankingFeeCents,
                netDisbursementCents,
                stripePaymentIntentId: pi.id,
              },
            },
          });
        });

        console.log('✅ Loan funding settled from Stripe webhook:', {
          loanId,
          paymentIntentId: pi.id,
          netDisbursementCents,
        });

        break;
      }

      /**
       * Existing wallet ACH deposit settlement.
       */
      if (pi.metadata?.purpose === 'wallet_deposit_ach') {
        // keep your existing wallet_deposit_ach logic here
      }

      break;
    }

            case 'payment_intent.payment_failed': {
        const pi = event.data.object;

        if (pi.metadata?.purpose === 'LOAN_FUNDING') {
          const loanId = pi.metadata?.loanId;

          if (loanId) {
            await prisma.loan.update({
              where: { id: loanId },
              data: {
                status: 'ACCEPTED',
                updatedAt: new Date(),
              },
            });
          }

          break;
        }

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
