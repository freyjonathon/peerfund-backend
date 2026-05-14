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
           * Wallet ACH deposit settlement:
           * Move user's ACH deposit from pendingCents to availableCents.
           */
          if (pi.metadata?.purpose === 'wallet_deposit_ach') {
            const walletId = pi.metadata?.walletId;
            const userId = pi.metadata?.userId;
            const netCents = Number(pi.metadata?.netCents || 0);
            const peerfundFeeCents = Number(pi.metadata?.peerfundFeeCents || 0);
            const processingFeeCents = Number(pi.metadata?.estimatedAchFeeCents || 0);

            if (!walletId || !userId || !netCents) {
              console.warn('ACH wallet deposit succeeded but missing metadata:', {
                paymentIntentId: pi.id,
                walletId,
                userId,
                netCents,
              });
              break;
            }

            const existingSettledLedger = await prisma.walletLedger.findFirst({
              where: {
                walletId,
                type: 'DEPOSIT',
                referenceType: 'StripePI',
                metadata: {
                  path: ['externalId'],
                  equals: pi.id,
                },
              },
            });

            if (existingSettledLedger?.metadata?.status === 'ACH_SETTLED') {
              console.log('ACH wallet deposit already settled:', pi.id);
              break;
            }

            const pendingLedgerRows = await prisma.walletLedger.findMany({
              where: {
                walletId,
                type: 'DEPOSIT',
                referenceType: 'StripePI',
              },
              orderBy: { createdAt: 'desc' },
              take: 100,
            });

            const pendingLedger =
              pendingLedgerRows.find((row) => {
                const meta = row.metadata || {};
                return (
                  meta.externalId === pi.id &&
                  meta.method === 'ach' &&
                  meta.pending === true
                );
              }) ||
              pendingLedgerRows.find((row) => {
                const meta = row.metadata || {};
                return (
                  meta.method === 'ach' &&
                  meta.pending === true &&
                  row.amountCents === netCents
                );
              });

            if (!pendingLedger) {
              console.warn('No pending wallet ledger found for ACH deposit:', {
                paymentIntentId: pi.id,
                walletId,
                netCents,
              });
              break;
            }

            await prisma.$transaction(async (tx) => {
              const currentWallet = await tx.wallet.findUnique({
                where: { id: walletId },
              });

              if (!currentWallet) {
                throw new Error(`Wallet not found during ACH settlement: ${walletId}`);
              }

              const pendingDecrement = Math.min(currentWallet.pendingCents, netCents);
              const newAvailable = currentWallet.availableCents + netCents;

              await tx.wallet.update({
                where: { id: walletId },
                data: {
                  pendingCents: { decrement: pendingDecrement },
                  availableCents: { increment: netCents },
                },
              });

              await tx.walletLedger.update({
                where: { id: pendingLedger.id },
                data: {
                  balanceAfterCents: newAvailable,
                  metadata: {
                    ...(pendingLedger.metadata || {}),
                    pending: false,
                    status: 'ACH_SETTLED',
                    settledAt: new Date().toISOString(),
                    stripeStatus: pi.status,
                    paymentIntentId: pi.id,
                  },
                },
              });

              const feeRows = [];

              if (peerfundFeeCents > 0) {
                feeRows.push({
                  type: 'PLATFORM_FEE',
                  amount: peerfundFeeCents / 100,
                  fromUserId: userId,
                  toUserId: process.env.PLATFORM_FEE_USER_ID || undefined,
                  peerfundFee: peerfundFeeCents / 100,
                  bankingFee: 0,
                  processedAt: new Date(),
                  timestamp: new Date(),
                });
              }

              if (processingFeeCents > 0) {
                feeRows.push({
                  type: 'ACH_FEE_RECOVERY',
                  amount: processingFeeCents / 100,
                  fromUserId: userId,
                  toUserId: process.env.PLATFORM_FEE_USER_ID || undefined,
                  peerfundFee: 0,
                  bankingFee: processingFeeCents / 100,
                  processedAt: new Date(),
                  timestamp: new Date(),
                });
              }

              if (feeRows.length) {
                await tx.transaction.createMany({
                  data: feeRows.filter((r) => !!r.toUserId),
                });
              }
            });

            console.log('✅ ACH wallet deposit settled from main Stripe webhook:', {
              paymentIntentId: pi.id,
              walletId,
              netCents,
            });

            break;
          }

          /**
           * Existing loan payment intent logic.
           */
          const loanId = pi.metadata?.loanId;

          if (loanId) {
            await prisma.loan.update({
              where: { id: loanId },
              data: {
                status: 'PROCESSING',
                chargeId: pi.latest_charge || undefined,
              },
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
