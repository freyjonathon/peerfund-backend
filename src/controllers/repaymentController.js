// src/controllers/repaymentController.js
const prisma = require('../utils/prisma');
const {
  PEERFUND_FEE_RATE,
  BANKING_FEE_RATE,
  calcFees,
  STRIPE_CARD_PERCENT = 0.029,
  STRIPE_CARD_FIXED_CENTS = 30,
} = require('../utils/fees');
const { WalletEntryType } = require('@prisma/client');
const { getWalletOrCreate } = require('../utils/wallet');
const { stripe } = require('../lib/stripeIdentities');

const PLATFORM_USER_ID =
  process.env.PLATFORM_FEE_USER_ID || '68f523b619356751fcb1ed4b';

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const dollarsToCents = (n) => Math.round(Number(n || 0) * 100);

function grossUpForStripeCard(netCents) {
  const grossCents = Math.ceil(
    (netCents + STRIPE_CARD_FIXED_CENTS) / (1 - STRIPE_CARD_PERCENT)
  );

  const estimatedStripeFeeCents = Math.ceil(
    grossCents * STRIPE_CARD_PERCENT + STRIPE_CARD_FIXED_CENTS
  );

  return {
    netCents,
    grossCents,
    estimatedStripeFeeCents,
    totalFeeCents: grossCents - netCents,
  };
}

async function applyWalletCreditsForRepaymentTx(tx, { loan, loanId, base, bankingFee, platformFee }) {
  const lenderId = loan?.lender?.id || loan?.lenderId;

  const baseCents = dollarsToCents(base);
  const bankCents = dollarsToCents(bankingFee);
  const platformCents = dollarsToCents(platformFee);
  const totalFeeCents = bankCents + platformCents;

  if (lenderId && baseCents > 0) {
    const lenderWallet = await tx.wallet.upsert({
      where: { userId: lenderId },
      update: {},
      create: {
        userId: lenderId,
        availableCents: 0,
        pendingCents: 0,
      },
    });

    const newBal = lenderWallet.availableCents + baseCents;

    await tx.wallet.update({
      where: { id: lenderWallet.id },
      data: { availableCents: newBal },
    });

    await tx.walletLedger.create({
      data: {
        walletId: lenderWallet.id,
        type: WalletEntryType.DISBURSE,
        amountCents: baseCents,
        direction: 'CREDIT',
        balanceAfterCents: newBal,
        referenceType: 'Loan',
        referenceId: loanId,
        metadata: {
          loanId,
          reason: 'REPAYMENT_BASE',
        },
      },
    });
  }

  if (PLATFORM_USER_ID && totalFeeCents > 0) {
    const platformWallet = await tx.wallet.upsert({
      where: { userId: PLATFORM_USER_ID },
      update: {},
      create: {
        userId: PLATFORM_USER_ID,
        availableCents: 0,
        pendingCents: 0,
      },
    });

    const newBal = platformWallet.availableCents + totalFeeCents;

    await tx.wallet.update({
      where: { id: platformWallet.id },
      data: { availableCents: newBal },
    });

    await tx.walletLedger.create({
      data: {
        walletId: platformWallet.id,
        type: WalletEntryType.ADJUSTMENT,
        amountCents: totalFeeCents,
        direction: 'CREDIT',
        balanceAfterCents: newBal,
        referenceType: 'Loan',
        referenceId: loanId,
        metadata: {
          loanId,
          reason: 'REPAYMENT_FEES',
          bankCents,
          platformCents,
        },
      },
    });
  }
}

async function createRepaymentAccountingTx(tx, {
  loan,
  loanId,
  repaymentId,
  base,
  finalBanking,
  finalPeerfund,
}) {
  const txRows = [];

  if (loan.lender?.id && base > 0) {
    txRows.push({
      type: 'REPAYMENT',
      amount: r2(base),
      fromUserId: loan.borrowerId,
      toUserId: loan.lender.id,
      loanId,
    });
  }

  if (finalBanking > 0) {
    txRows.push({
      type: 'BANK_FEE',
      amount: r2(finalBanking),
      fromUserId: loan.borrowerId,
      toUserId: PLATFORM_USER_ID,
      loanId,
    });
  }

  if (finalPeerfund > 0) {
    txRows.push({
      type: 'PLATFORM_FEE',
      amount: r2(finalPeerfund),
      fromUserId: loan.borrowerId,
      toUserId: PLATFORM_USER_ID,
      loanId,
    });
  }

  if (txRows.length) {
    await tx.transaction.createMany({ data: txRows });
  }

  const feeRecords = [];

  if (finalBanking > 0) {
    feeRecords.push({
      loanId,
      repaymentId,
      type: 'BANK_FEE',
      amount: r2(finalBanking),
    });
  }

  if (finalPeerfund > 0) {
    feeRecords.push({
      loanId,
      repaymentId,
      type: 'PLATFORM_FEE',
      amount: r2(finalPeerfund),
    });
  }

  if (feeRecords.length) {
    await tx.fee.createMany({ data: feeRecords });
  }
}

exports.getLoanRepayments = async (req, res) => {
  const { loanId } = req.params;

  try {
    const repayments = await prisma.repayment.findMany({
      where: { loanId },
      orderBy: { dueDate: 'asc' },
    });

    res.status(200).json(repayments);
  } catch (err) {
    console.error('Error fetching repayments:', err);
    res.status(500).json({ error: 'Failed to fetch repayments' });
  }
};

exports.recordRepayment = async (req, res) => {
  const { repaymentId } = req.params;
  const { amountPaid } = req.body;

  try {
    const repayment = await prisma.repayment.update({
      where: { id: repaymentId },
      data: {
        amountPaid: Number(amountPaid) || 0,
        status: amountPaid > 0 ? 'PAID' : 'PENDING',
        paidAt: amountPaid > 0 ? new Date() : null,
      },
    });

    res.status(200).json(repayment);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update repayment' });
  }
};

exports.makeRepayment = async (req, res) => {
  const userId = req.user.userId;
  const { loanId } = req.params;
  const { amount } = req.body;

  try {
    const loan = await prisma.loan.findUnique({
      where: { id: loanId },
      select: {
        id: true,
        borrowerId: true,
        borrower: { select: { id: true, isSuperUser: true } },
        lender: { select: { id: true } },
        repayments: {
          orderBy: { dueDate: 'asc' },
          select: {
            id: true,
            status: true,
            basePayment: true,
          },
        },
      },
    });

    if (!loan || loan.borrowerId !== userId) {
      return res.status(403).json({ error: 'Unauthorized or loan not found' });
    }

    const nextRepayment = loan.repayments.find((r) => r.status === 'PENDING');

    if (!nextRepayment) {
      return res.status(400).json({ error: 'No pending repayments' });
    }

    const base = Number(nextRepayment.basePayment) || 0;

    let { peerfundFee, bankingFee, totalFees, totalCharge } = calcFees(base);

    if (loan.borrower.isSuperUser) {
      peerfundFee = 0;
      totalFees = r2(peerfundFee + bankingFee);
      totalCharge = r2(base + totalFees);
    }

    const paymentAmount = Number(amount);

    if (!Number.isFinite(paymentAmount)) {
      return res.status(400).json({ error: 'Amount must be a number' });
    }

    if (paymentAmount < totalCharge) {
      return res.status(400).json({
        error: `Minimum payment is $${totalCharge.toFixed(2)}. Your payment: $${paymentAmount.toFixed(2)}`,
      });
    }

    const paidAt = new Date();
    const finalBanking = r2(bankingFee);
    const finalPeerfund = r2(peerfundFee);

    const updated = await prisma.$transaction(async (tx) => {
      const repayment = await tx.repayment.update({
        where: { id: nextRepayment.id },
        data: {
          amountPaid: paymentAmount,
          basePayment: base,
          bankingFee: finalBanking,
          peerfundFee: finalPeerfund,
          totalCharged: r2(totalCharge),
          status: 'PAID',
          paidAt,
        },
      });

      await createRepaymentAccountingTx(tx, {
        loan,
        loanId,
        repaymentId: repayment.id,
        base,
        finalBanking,
        finalPeerfund,
      });

      await applyWalletCreditsForRepaymentTx(tx, {
        loan,
        loanId,
        base,
        bankingFee: finalBanking,
        platformFee: finalPeerfund,
      });

      return repayment;
    });

    return res.status(200).json({
      message: 'Repayment submitted successfully',
      amountPaid: paymentAmount,
      breakdown: {
        base,
        bankingFee: finalBanking,
        peerfundFee: finalPeerfund,
        total: r2(totalCharge),
      },
      repaymentId: updated.id,
    });
  } catch (err) {
    console.error('💥 makeRepayment error:', err);
    res.status(500).json({ error: 'Failed to submit repayment' });
  }
};

exports.payNextRepayment = async (req, res) => {
  try {
    const borrowerId = req.user.userId;
    const { loanId } = req.params;
    const { paymentSource = 'wallet' } = req.body || {};

    const normalizedSource =
      paymentSource === 'card' || paymentSource === 'funding_card'
        ? 'card'
        : 'wallet';

    console.log('🔔 payNextRepayment called', {
      loanId,
      borrowerId,
      paymentSource: normalizedSource,
    });

    const loan = await prisma.loan.findFirst({
      where: { id: loanId, borrowerId },
      select: {
        id: true,
        borrowerId: true,
        lenderId: true,
        borrower: {
          select: {
            id: true,
            isSuperUser: true,
            stripeCustomerId: true,
            fundingPaymentMethodId: true,
          },
        },
        lender: { select: { id: true } },
      },
    });

    if (!loan) {
      return res.status(404).json({ error: 'Loan not found' });
    }

    const next = await prisma.repayment.findFirst({
      where: { loanId: loan.id, status: 'PENDING' },
      orderBy: { dueDate: 'asc' },
      select: {
        id: true,
        basePayment: true,
        bankingFee: true,
        peerfundFee: true,
        totalCharged: true,
        dueDate: true,
      },
    });

    if (!next) {
      return res.status(400).json({ error: 'No pending repayment' });
    }

    const base = Number(next.basePayment) || 0;

    let { peerfundFee, bankingFee, totalFees, totalCharge } = calcFees(base);

    if (loan.borrower.isSuperUser) {
      peerfundFee = 0;
      totalFees = r2(bankingFee + peerfundFee);
      totalCharge = r2(base + totalFees);
    }

    const finalPeerfund =
      typeof next.peerfundFee === 'number' ? next.peerfundFee : r2(peerfundFee);

    const finalBanking =
      typeof next.bankingFee === 'number' ? next.bankingFee : r2(bankingFee);

    const finalTotal =
      typeof next.totalCharged === 'number' && next.totalCharged > 0
        ? next.totalCharged
        : r2(base + finalPeerfund + finalBanking);

    const finalTotalCents = dollarsToCents(finalTotal);

    let stripePaymentIntent = null;
    let cardGross = null;

    if (normalizedSource === 'card') {
      if (!stripe) {
        return res.status(500).json({ error: 'Stripe not configured' });
      }

      if (!loan.borrower?.stripeCustomerId || !loan.borrower?.fundingPaymentMethodId) {
        return res.status(400).json({
          error: 'No saved funding card found. Please save a funding card in your Wallet.',
        });
      }

      cardGross = grossUpForStripeCard(finalTotalCents);

      stripePaymentIntent = await stripe.paymentIntents.create({
        amount: cardGross.grossCents,
        currency: 'usd',
        customer: loan.borrower.stripeCustomerId,
        payment_method: loan.borrower.fundingPaymentMethodId,
        off_session: true,
        confirm: true,
        metadata: {
          borrowerId,
          loanId,
          repaymentId: next.id,
          purpose: 'loan_repayment',
          netRepaymentCents: String(cardGross.netCents),
          grossChargeCents: String(cardGross.grossCents),
          estimatedStripeFeeCents: String(cardGross.estimatedStripeFeeCents),
        },
      });

      if (stripePaymentIntent.status !== 'succeeded') {
        return res.status(400).json({
          error: `PaymentIntent not succeeded (status=${stripePaymentIntent.status})`,
        });
      }
    }

    const paidAt = new Date();

    const result = await prisma.$transaction(async (tx) => {
      if (normalizedSource === 'wallet') {
        const borrowerWallet = await tx.wallet.upsert({
          where: { userId: borrowerId },
          update: {},
          create: {
            userId: borrowerId,
            availableCents: 0,
            pendingCents: 0,
          },
        });

        if (borrowerWallet.availableCents < finalTotalCents) {
          throw new Error('Insufficient wallet balance');
        }

        const newBorrowerBal = borrowerWallet.availableCents - finalTotalCents;

        await tx.wallet.update({
          where: { id: borrowerWallet.id },
          data: { availableCents: newBorrowerBal },
        });

        await tx.walletLedger.create({
          data: {
            walletId: borrowerWallet.id,
            type: WalletEntryType.REPAYMENT,
            amountCents: finalTotalCents,
            direction: 'DEBIT',
            balanceAfterCents: newBorrowerBal,
            referenceType: 'Loan',
            referenceId: loanId,
            metadata: {
              loanId,
              repaymentId: next.id,
              reason: 'REPAYMENT_DEBIT',
              source: 'WALLET',
              baseCents: dollarsToCents(base),
              bankingFeeCents: dollarsToCents(finalBanking),
              peerfundFeeCents: dollarsToCents(finalPeerfund),
            },
          },
        });
      }

      const updated = await tx.repayment.update({
        where: { id: next.id },
        data: {
          status: 'PAID',
          paidAt,
          basePayment: base,
          peerfundFee: r2(finalPeerfund),
          bankingFee: r2(finalBanking),
          totalCharged: r2(finalTotal),
          amountPaid: r2(finalTotal),
        },
        select: { id: true, status: true, paidAt: true, totalCharged: true },
      });

      await createRepaymentAccountingTx(tx, {
        loan,
        loanId,
        repaymentId: next.id,
        base,
        finalBanking,
        finalPeerfund,
      });

      await applyWalletCreditsForRepaymentTx(tx, {
        loan,
        loanId,
        base,
        bankingFee: finalBanking,
        platformFee: finalPeerfund,
      });

      const remaining = await tx.repayment.count({
        where: { loanId, status: 'PENDING' },
      });

      if (remaining === 0) {
        await tx.loan.update({
          where: { id: loanId },
          data: { status: 'PAID_OFF' },
        });
      }

      return updated;
    });

    return res.json({
      ok: true,
      repaymentId: result.id,
      status: result.status,
      paidAt: result.paidAt,
      amount: result.totalCharged,
      paymentSource: normalizedSource,
      stripePaymentIntentId: stripePaymentIntent?.id || null,
      cardCharge:
        cardGross && normalizedSource === 'card'
          ? {
              grossCents: cardGross.grossCents,
              netRepaymentCents: cardGross.netCents,
              estimatedStripeFeeCents: cardGross.estimatedStripeFeeCents,
              totalFeeCents: cardGross.totalFeeCents,
            }
          : null,
    });
  } catch (err) {
    console.error('💥 payNextRepayment error:', err);

    return res.status(500).json({
      error:
        err?.raw?.message ||
        err?.message ||
        'Payment failed',
    });
  }
};