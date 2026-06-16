// src/controllers/loanOfferController.js
const prisma = require('../utils/prisma');
const { PEERFUND_FEE_RATE, BANKING_FEE_RATE } = require('../utils/fees');
const { ALLOWED_AMOUNTS, isAllowedAmount } = require('../utils/loanTiers');
const { getUserId } = require('../middleware/authMiddleware');
const { WalletEntryType } = require('@prisma/client');
const { getWalletOrCreate } = require('../utils/wallet');
const { stripe } = require('../lib/stripeIdentities');

exports.submitLoanOffer = async (req, res) => {
  const { loanId } = req.params;
  const userId = req.user.userId;
  const { interestRate, message } = req.body;

  try {
    const loanReq = await prisma.loanRequest.findUnique({
      where: { id: loanId },
      select: { id: true, borrowerId: true, status: true, amount: true, duration: true },
    });

    if (!loanReq) return res.status(404).json({ error: 'Loan request not found' });
    if (loanReq.status !== 'OPEN') {
      return res.status(400).json({ error: 'Loan request is not open for offers' });
    }
    if (loanReq.borrowerId === userId) {
      return res.status(403).json({ error: 'You cannot submit an offer to your own request' });
    }
    if (!isAllowedAmount(loanReq.amount)) {
      return res.status(400).json({
        error: `Loan amount must be one of: ${ALLOWED_AMOUNTS.join(', ')}`,
      });
    }

    const rate = Number(interestRate);
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
      return res.status(400).json({ error: 'Interest rate must be between 0 and 100%' });
    }

    const offer = await prisma.loanOffer.create({
      data: {
        loanRequestId: loanId,
        lenderId: userId,
        amount: Number(loanReq.amount),
        duration: Number(loanReq.duration),
        interestRate: rate,
        message: message ? String(message).slice(0, 1000) : null,
      },
      include: { lender: { select: { id: true, name: true } } },
    });

    return res.status(201).json(offer);
  } catch (err) {
    console.error('Submit loan offer failed:', err);
    return res.status(500).json({ error: 'Failed to submit loan offer' });
  }
};

exports.getLoanOffers = async (req, res) => {
  const { loanId } = req.params;

  try {
    const offers = await prisma.loanOffer.findMany({
      where: { loanRequestId: loanId },
      include: { lender: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
    });

    return res.status(200).json(offers);
  } catch (err) {
    console.error('Error fetching loan offers:', err);
    return res.status(500).json({ error: 'Could not retrieve loan offers' });
  }
};

exports.getMyOfferRequests = async (req, res) => {
  const userId = req.user.userId;

  try {
    const rows = await prisma.loanRequest.findMany({
      where: {
        status: 'OPEN',
        loanOffers: { some: { lenderId: userId } },
      },
      include: {
        borrower: { select: { id: true, name: true } },
        loanOffers: {
          where: { lenderId: userId },
          select: {
            id: true,
            amount: true,
            duration: true,
            interestRate: true,
            message: true,
            createdAt: true,
            lenderId: true,
          },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return res.json({
      items: rows.map((r) => ({
        id: r.id,
        status: r.status,
        amount: r.amount,
        duration: r.duration,
        interestRate: r.interestRate,
        purpose: r.purpose,
        createdAt: r.createdAt,
        borrower: r.borrower,
        myOffer: r.loanOffers[0] || null,
      })),
    });
  } catch (err) {
    console.error('getMyOfferRequests error:', err);
    return res.status(500).json({ error: 'Failed to load your offer requests' });
  }
};

exports.acceptLoanOffer = async (req, res) => {
  const { offerId } = req.params;
  const userId = getUserId(req);

  const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const offer = await prisma.loanOffer.findUnique({
      where: { id: offerId },
      include: {
        loanRequest: { include: { borrower: true } },
        lender: { select: { id: true, name: true, isSuperUser: true } },
      },
    });

    if (!offer) return res.status(404).json({ error: 'Loan offer not found' });

    const lr = offer.loanRequest;
    if (!lr) return res.status(500).json({ error: 'Offer missing loan request' });

    if (String(lr.borrowerId) !== String(userId)) {
      return res.status(403).json({ error: 'Only the borrower can accept this offer' });
    }

    if ((lr.status || 'OPEN').toUpperCase() !== 'OPEN') {
      return res.status(400).json({ error: 'Loan request is not open' });
    }

    if ((offer.status || 'OPEN').toUpperCase() !== 'OPEN') {
      return res.status(400).json({ error: 'Offer is not open' });
    }

    const amount = Number(offer.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: 'Offer has invalid amount' });
    }

    // Borrower will receive proceeds into PeerFund wallet after lender funds directly
    // from a saved payment method. Borrower does not need a funding method at acceptance.
    await getWalletOrCreate(userId);

    const existingLoan = await prisma.loan.findFirst({
      where: { loanRequestId: offer.loanRequestId },
    });

    if (existingLoan) {
      return res.status(400).json({ error: 'Loan already accepted for this request' });
    }

    const acceptanceTimestamp = new Date();

    const termRatePct = (Number(offer.interestRate) || 0) + 2;
    const termRate = termRatePct / 100;
    const totalBaseRepayment = r2(amount * (1 + termRate));
    const baseMonthlyPayment = r2(totalBaseRepayment / Number(offer.duration));

    const repaymentPeerfundEach = offer.lender.isSuperUser
      ? 0
      : r2(baseMonthlyPayment * PEERFUND_FEE_RATE);

    const repaymentBankingEach = r2(baseMonthlyPayment * BANKING_FEE_RATE);

    const scheduleRows = [];
    const due = new Date();

    for (let i = 0; i < Number(offer.duration); i++) {
      due.setMonth(due.getMonth() + 1);

      const totalCharged = r2(
        baseMonthlyPayment + repaymentBankingEach + repaymentPeerfundEach
      );

      scheduleRows.push({
        loanId: '',
        dueDate: new Date(due),
        basePayment: baseMonthlyPayment,
        bankingFee: repaymentBankingEach,
        peerfundFee: repaymentPeerfundEach,
        totalCharged,
        amountDue: totalCharged,
        amountPaid: 0,
        status: 'PENDING',
      });
    }

    const principalCents = Math.round(amount * 100);
    const termMonths = Number(offer.duration);
    const interestRateBps = Math.round(Number(offer.interestRate) * 100);

    const loan = await prisma.$transaction(async (tx) => {
      const created = await tx.loan.create({
        data: {
          principalCents,
          interestRateBps,
          termMonths,

          amount,
          duration: termMonths,
          interestRate: Number(offer.interestRate),

          borrowerId: lr.borrowerId,
          lenderId: offer.lenderId,
          loanRequestId: lr.id,

          status: 'ACCEPTED',
          createdAt: new Date(),
          updatedAt: new Date(),
          disbursedAmount: 0,
        },
        include: { lender: true },
      });

      await tx.loanOffer.update({
        where: { id: offerId },
        data: {
          status: 'ACCEPTED',
          acceptedAt: acceptanceTimestamp,
        },
      });

      await tx.loanOffer.updateMany({
        where: {
          loanRequestId: lr.id,
          status: 'OPEN',
          NOT: { id: offerId },
        },
        data: { status: 'REJECTED' },
      });

      await tx.loanRequest.update({
        where: { id: lr.id },
        data: { status: 'CLOSED', offerAccepted: true },
      });

      const contractContent = `Loan Contract Agreement

Borrower: ${lr.borrower?.name || 'Borrower'}
Lender: ${created.lender.name}
Amount: $${amount}
Duration: ${termMonths} months
Base Interest Rate: ${offer.interestRate}%
Per installment additional fees:
- PeerFund: ${
        offer.lender.isSuperUser
          ? 'WAIVED (Super User)'
          : `${(PEERFUND_FEE_RATE * 100).toFixed(2)}% of base`
      }
- Banking/Stripe: ${(BANKING_FEE_RATE * 100).toFixed(2)}% of base

Total Effective Interest Rate (display): ${termRatePct}%
Accepted At: ${acceptanceTimestamp.toISOString()}`;

      await tx.document.create({
        data: {
          userId,
          loanId: created.id,
          type: 'contract',
          title: `Loan Agreement with ${created.lender.name}`,
          fileName: `loan_contract_${created.id}.txt`,
          mimeType: 'text/plain',
          content: Buffer.from(contractContent),
        },
      });

      await tx.notification.create({
        data: {
          userId,
          type: 'DOCUMENT',
          message: `✅ Your loan contract with ${created.lender.name} has been finalized.`,
        },
      });

      await tx.repayment.createMany({
        data: scheduleRows.map((row) => ({
          ...row,
          loanId: created.id,
        })),
      });

      return created;
    });

    return res.status(201).json({
      message: 'Loan accepted and contract saved. Waiting for lender to fund.',
      loan,
    });
  } catch (err) {
    console.error('🔥 acceptLoanOffer error:', err);
    return res.status(500).json({ error: 'Could not accept offer' });
  }
};

/**
 * POST /api/loans/:loanId/fund
 *
 * New PeerFund funding model:
 * - Lender does NOT need to pre-deposit into PeerFund wallet.
 * - Lender is charged directly using saved ACH/payment method.
 * - Borrower receives funded amount into PeerFund wallet.
 * - Borrower can withdraw later through Stripe Connect payout setup.
 */
exports.fundLoanByLender = async (req, res) => {
  try {
    console.log('💸 fundLoanByLender direct-payment-to-borrower-wallet hit');

    const lenderId = getUserId(req);
    if (!lenderId) return res.status(401).json({ error: 'Unauthorized' });

    if (!stripe) {
      return res.status(500).json({
        code: 'STRIPE_NOT_CONFIGURED',
        error: 'Stripe is not configured on the server.',
      });
    }

    const { loanId } = req.params;

    const loan = await prisma.loan.findUnique({
      where: { id: loanId },
      include: { borrower: true, lender: true },
    });

    if (!loan) return res.status(404).json({ error: 'Loan not found' });

    if (String(loan.lenderId) !== String(lenderId)) {
      return res.status(403).json({ error: 'Only the lender can fund this loan' });
    }

    const status = (loan.status || '').toUpperCase();

    if (status === 'FUNDED') {
      return res.status(409).json({ error: 'Loan already funded' });
    }

    if (status === 'PROCESSING') {
      return res.status(202).json({
        ok: true,
        status: 'PROCESSING',
        message: 'Funding payment is already processing.',
        loan,
      });
    }

    if (status !== 'ACCEPTED') {
      return res.status(400).json({
        error: 'Loan is not ready to fund. Status must be ACCEPTED.',
      });
    }

    const principalCents = Number.isFinite(loan.principalCents)
      ? loan.principalCents
      : Math.round((loan.amount || 0) * 100);

    if (!principalCents || principalCents <= 0) {
      return res.status(400).json({ error: 'Invalid principal amount' });
    }

    const principalDollars = principalCents / 100;

    const lender = await prisma.user.findUnique({
      where: { id: lenderId },
      select: {
        id: true,
        name: true,
        email: true,
        stripeCustomerId: true,
        fundingPaymentMethodId: true,
      },
    });

    if (!lender) {
      return res.status(404).json({ error: 'Lender not found' });
    }

      let paymentMethodId = null;
      let stripeCustomerId = lender.stripeCustomerId || null;
      let paymentMethodSource = 'SAVED_ACH';

      const savedAch = await prisma.paymentMethod.findFirst({
        where: {
          userId: lenderId,
          type: 'US_BANK',
          status: 'ACTIVE',
        },
        orderBy: [
          { isDefaultCharge: 'desc' },
          { createdAt: 'desc' },
        ],
        select: {
          stripePaymentMethodId: true,
          stripeCustomerId: true,
          type: true,
          bankName: true,
          last4: true,
        },
      });

      console.log('🏦 Lender ACH lookup result', {
        lenderId,
        found: !!savedAch,
        type: savedAch?.type,
        bankName: savedAch?.bankName,
        last4: savedAch?.last4,
        stripePaymentMethodId: savedAch?.stripePaymentMethodId,
      });

      if (savedAch?.stripePaymentMethodId) {
        paymentMethodId = savedAch.stripePaymentMethodId;
        stripeCustomerId = savedAch.stripeCustomerId || stripeCustomerId;
      }

      if (!stripeCustomerId || !paymentMethodId) {
        return res.status(400).json({
          code: 'MISSING_LENDER_ACH_METHOD',
          error: 'Please link a bank account before funding this loan.',
        });
      }

    let paymentMethod;

    try {
      paymentMethod = await stripe.paymentMethods.retrieve(paymentMethodId);
    } catch (err) {
      console.error('Could not retrieve lender payment method:', err);

      return res.status(400).json({
        code: 'INVALID_LENDER_PAYMENT_METHOD',
        error:
          'The saved funding method could not be verified. Please re-save your payment method.',
      });
    }

    const paymentMethodType = paymentMethod?.type || 'us_bank_account';

    console.log('🧾 Creating Stripe loan funding PaymentIntent', {
      loanId: loan.id,
      lenderId,
      borrowerId: loan.borrowerId,
      principalCents,
      stripeCustomerId,
      paymentMethodId,
      paymentMethodType,
      paymentMethodSource,
    });

    let pi;

    try {
      pi = await stripe.paymentIntents.create(
        {
          amount: principalCents,
          currency: 'usd',
          customer: stripeCustomerId,
          payment_method: paymentMethodId,
          confirm: true,
          off_session: true,
          payment_method_types: [paymentMethodType],
          description: `PeerFund loan funding for loan ${loan.id}`,
          metadata: {
            purpose: 'LOAN_FUNDING',
            loanId: loan.id,
            lenderId,
            borrowerId: loan.borrowerId,
            principalCents: String(principalCents),
            paymentMethodSource,
            paymentMethodType,
          },
        },
        {
          idempotencyKey: `peerfund-loan-funding-${loan.id}`,
        }
      );

      console.log('✅ Stripe funding result', {
        paymentIntentId: pi.id,
        status: pi.status,
        amount: pi.amount,
        currency: pi.currency,
      });
    } catch (err) {
      console.error('Stripe loan funding payment failed:', {
        message: err?.message,
        code: err?.code,
        rawCode: err?.raw?.code,
        rawMessage: err?.raw?.message,
        type: err?.type,
      });

      return res.status(400).json({
        code: err?.code || err?.raw?.code || 'LOAN_FUNDING_PAYMENT_FAILED',
        error:
          err?.raw?.message ||
          err?.message ||
          'Unable to charge the lender funding method.',
      });
    }

    if (pi.status === 'processing') {
      await prisma.loan.update({
        where: { id: loan.id },
        data: {
          status: 'PROCESSING',
          updatedAt: new Date(),
        },
      });

      return res.status(202).json({
        ok: true,
        status: 'PROCESSING',
        message:
          'Loan funding payment is processing. The borrower wallet will be credited once payment succeeds.',
        paymentIntentId: pi.id,
        loanId: loan.id,
      });
    }

    if (pi.status !== 'succeeded') {
      return res.status(400).json({
        code: 'LOAN_FUNDING_NOT_SUCCEEDED',
        error: `Loan funding payment did not succeed. Current Stripe status: ${pi.status}`,
        paymentIntentId: pi.id,
        stripeStatus: pi.status,
      });
    }

    await prisma.$transaction(async (tx) => {
      const borrowerWallet = await tx.wallet.upsert({
        where: { userId: loan.borrowerId },
        update: {},
        create: {
          userId: loan.borrowerId,
          availableCents: 0,
          pendingCents: 0,
        },
      });

      const borrowerNewBalance = borrowerWallet.availableCents + principalCents;

      await tx.wallet.update({
        where: { id: borrowerWallet.id },
        data: {
          availableCents: borrowerNewBalance,
        },
      });

      await tx.walletLedger.create({
        data: {
          walletId: borrowerWallet.id,
          type: WalletEntryType.DISBURSE,
          amountCents: principalCents,
          direction: 'CREDIT',
          balanceAfterCents: borrowerNewBalance,
          referenceType: 'Loan',
          referenceId: loan.id,
          metadata: {
            reason: 'LOAN_FUNDED_BORROWER_CREDIT',
            fundingModel: 'DIRECT_LENDER_PAYMENT_TO_BORROWER_WALLET',
            stripePaymentIntentId: pi.id,
            stripeStatus: pi.status,
            loanId: loan.id,
            borrowerId: loan.borrowerId,
            lenderId: loan.lenderId,
            paymentMethodSource,
            paymentMethodType,
          },
        },
      });

      try {
        await tx.transaction.create({
          data: {
            type: 'DISBURSEMENT',
            amount: principalDollars,
            loanId: loan.id,
            fromUserId: lenderId,
            toUserId: loan.borrowerId,
            processedAt: new Date(),
            timestamp: new Date(),
          },
        });
      } catch (err) {
        console.warn('⚠️ transaction.create failed but funding continued:', err.message);
      }

      await tx.loan.update({
        where: { id: loan.id },
        data: {
          status: 'FUNDED',
          disbursedAmount: principalDollars,
          updatedAt: new Date(),
        },
      });

      await tx.notification.create({
        data: {
          userId: loan.borrowerId,
          type: 'WALLET',
          message: `💸 Your loan has been funded. $${principalDollars.toFixed(
            2
          )} is now available in your PeerFund wallet.`,
          data: {
            loanId: loan.id,
            lenderId,
            amountCents: principalCents,
            stripePaymentIntentId: pi.id,
            paymentMethodSource,
            paymentMethodType,
          },
        },
      });
    });

    const updated = await prisma.loan.findUnique({
      where: { id: loan.id },
    });

    return res.json({
      ok: true,
      loan: updated,
      payment: {
        paymentIntentId: pi.id,
        status: pi.status,
        chargedCents: principalCents,
        paymentMethodSource,
        paymentMethodType,
      },
      disbursement: {
        transferId: 'peerfund-direct-payment-to-wallet',
        netCents: principalCents,
        platformFeeCents: 0,
      },
    });
  } catch (err) {
    console.error('fundLoanByLender error:', err);

    return res.status(500).json({
      error: err?.message || 'Failed to fund loan',
    });
  }
};