// src/controllers/loanOfferController.js
const prisma = require('../utils/prisma');
const { PEERFUND_FEE_RATE, BANKING_FEE_RATE } = require('../utils/fees');
const { ALLOWED_AMOUNTS, isAllowedAmount } = require('../utils/loanTiers');
const { getUserId } = require('../middleware/authMiddleware');
const { disburseLoanNow } = require('../services/disbursementService');
const { WalletEntryType } = require('@prisma/client');
const { getWalletOrCreate } = require('../utils/wallet');

/**
 * POST /api/loans/:loanId/offers
 * Create an offer for a given loan request.
 * Server pulls canonical amount/duration from the request and enforces tiers.
 */
exports.submitLoanOffer = async (req, res) => {
  const { loanId } = req.params;
  const userId = req.user.userId;
  const { interestRate, message } = req.body; // ignore client amount/duration

  try {
    const loanReq = await prisma.loanRequest.findUnique({
      where: { id: loanId },
      select: {
        id: true,
        borrowerId: true,
        status: true,
        amount: true,
        duration: true,
      },
    });

    if (!loanReq) return res.status(404).json({ error: 'Loan request not found' });
    if (loanReq.status !== 'OPEN') {
      return res.status(400).json({ error: 'Loan request is not open for offers' });
    }
    if (loanReq.borrowerId === userId) {
      return res.status(403).json({ error: 'You cannot submit an offer to your own request' });
    }
    if (!isAllowedAmount(loanReq.amount)) {
      return res
        .status(400)
        .json({ error: `Loan amount must be one of: ${ALLOWED_AMOUNTS.join(', ')}` });
    }

    const rate = Number(interestRate);
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
      return res.status(400).json({ error: 'Interest rate must be between 0 and 100%' });
    }
    const cleanMsg = message ? String(message).slice(0, 1000) : null;

    const offer = await prisma.loanOffer.create({
      data: {
        loanRequestId: loanId,
        lenderId: userId,
        amount: Number(loanReq.amount),
        duration: Number(loanReq.duration),
        interestRate: rate,
        message: cleanMsg,
      },
      include: { lender: { select: { id: true, name: true } } },
    });

    return res.status(201).json(offer);
  } catch (err) {
    console.error('Submit loan offer failed:', err);
    return res.status(500).json({ error: 'Failed to submit loan offer' });
  }
};

/** GET /api/loans/:loanId/offers */
exports.getLoanOffers = async (req, res) => {
  const { loanId } = req.params;
  try {
    const offers = await prisma.loanOffer.findMany({
      where: { loanRequestId: loanId },
      include: { lender: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.status(200).json(offers);
  } catch (err) {
    console.error('Error fetching loan offers:', err);
    res.status(500).json({ error: 'Could not retrieve loan offers' });
  }
};

/**
 * GET /api/loans/offers/mine
 * Return OPEN loan requests where the current user has submitted an offer.
 * Includes the borrower info and the user’s own offer as `myOffer`.
 */
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

    const items = rows.map((r) => ({
      id: r.id,
      status: r.status,
      amount: r.amount,
      duration: r.duration,
      interestRate: r.interestRate,
      purpose: r.purpose,
      createdAt: r.createdAt,
      borrower: r.borrower,
      myOffer: r.loanOffers[0] || null,
    }));

    return res.json({ items });
  } catch (e) {
    console.error('getMyOfferRequests error:', e);
    return res.status(500).json({ error: 'Failed to load your offer requests' });
  }
};

// src/controllers/loanOfferController.js

/** POST /api/loans/offers/:offerId/accept  (BORROWER action)
 *  Creates the Loan and marks it ACCEPTED.
 *  Lender can later fund via POST /api/loans/:loanId/fund.
 */
exports.acceptLoanOffer = async (req, res) => {
  const { offerId } = req.params;
  const userId = getUserId(req);
  const r2 = (n) =>
    Math.round((Number(n) + Number.EPSILON) * 100) / 100;

  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const offer = await prisma.loanOffer.findUnique({
      where: { id: offerId },
      include: {
        loanRequest: { include: { borrower: true } },
        lender: { select: { id: true, name: true, isSuperUser: true } },
      },
    });

    if (!offer) {
      return res.status(404).json({ error: 'Loan offer not found' });
    }

    const lr = offer.loanRequest;
    if (!lr) {
      return res
        .status(500)
        .json({ error: 'Offer missing loan request' });
    }

    if (String(lr.borrowerId) !== String(userId)) {
      return res
        .status(403)
        .json({ error: 'Only the borrower can accept this offer' });
    }

    if ((lr.status || 'OPEN').toUpperCase() !== 'OPEN') {
      return res
        .status(400)
        .json({ error: 'Loan request is not open' });
    }

    if ((offer.status || 'OPEN').toUpperCase() !== 'OPEN') {
      return res
        .status(400)
        .json({ error: 'Offer is not open' });
    }

    const amount = Number(offer.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res
        .status(400)
        .json({ error: 'Offer has invalid amount' });
    }

    // Make sure we don't already have a loan for this request
    const existingLoan = await prisma.loan.findFirst({
      where: { loanRequestId: offer.loanRequestId },
    });
    if (existingLoan) {
      return res
        .status(400)
        .json({ error: 'Loan already accepted for this request' });
    }

    const acceptanceTimestamp = new Date();

    // Interest / schedule math
    const termRatePct = (Number(offer.interestRate) || 0) + 2;
    const termRate = termRatePct / 100;
    const totalBaseRepayment = r2(amount * (1 + termRate));
    const baseMonthlyPayment = r2(
      totalBaseRepayment / Number(offer.duration)
    );

    const repaymentPeerfundEach = offer.lender.isSuperUser
      ? 0
      : r2(baseMonthlyPayment * PEERFUND_FEE_RATE);
    const repaymentBankingEach = r2(
      baseMonthlyPayment * BANKING_FEE_RATE
    );

    const scheduleRows = [];
    let due = new Date();
    for (let i = 0; i < Number(offer.duration); i++) {
      due.setMonth(due.getMonth() + 1);
      const totalCharged = r2(
        baseMonthlyPayment + repaymentBankingEach + repaymentPeerfundEach
      );
      scheduleRows.push({
        loanId: '', // will be filled in after create
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
    const interestRateBps = Math.round(
      Number(offer.interestRate) * 100
    );

    const loan = await prisma.$transaction(async (tx) => {
      // Create the loan
      const created = await tx.loan.create({
        data: {
          // canonical
          principalCents,
          interestRateBps,
          termMonths,

          // legacy mirrors
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

      // Mark offer + request
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

      // Simple text contract
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

      const rowsWithLoanId = scheduleRows.map((r) => ({
        ...r,
        loanId: created.id,
      }));
      await tx.repayment.createMany({ data: rowsWithLoanId });

      return created;
    });

    return res.status(201).json({
      message:
        'Loan accepted and contract saved. Waiting for lender to fund.',
      loan,
    });
  } catch (err) {
    console.error('🔥 acceptLoanOffer error:', err);
    return res
      .status(500)
      .json({ error: 'Could not accept offer' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/loans/:loanId/fund  (LENDER action, wallet → wallet only)
//
// 1) Debit lender's wallet.availableCents
// 2) Credit borrower's wallet.availableCents
// 3) (Best effort) create a Transaction row using *amount* (dollars)
// 4) Mark loan FUNDED, set disbursedAmount (dollars) + updatedAt
// ─────────────────────────────────────────────────────────────────────────────
exports.fundLoanByLender = async (req, res) => {
  try {
    console.log('💸 fundLoanByLender (wallet-only) hit');

    const lenderId = getUserId(req);
    if (!lenderId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { loanId } = req.params;

    // Load the loan with borrower + lender
    const loan = await prisma.loan.findUnique({
      where: { id: loanId },
      include: { borrower: true, lender: true },
    });

    if (!loan) {
      return res.status(404).json({ error: 'Loan not found' });
    }

    if (String(loan.lenderId) !== String(lenderId)) {
      return res
        .status(403)
        .json({ error: 'Only the lender can fund this loan' });
    }

    const status = (loan.status || '').toUpperCase();
    if (status === 'FUNDED') {
      return res.status(409).json({ error: 'Loan already funded' });
    }
    if (status !== 'ACCEPTED') {
      return res.status(400).json({
        error: 'Loan is not ready to fund (status must be ACCEPTED)',
      });
    }

    // Canonical amount in cents
    const principalCents = Number.isFinite(loan.principalCents)
      ? loan.principalCents
      : Math.round((loan.amount || 0) * 100);

    if (!principalCents || principalCents <= 0) {
      return res.status(400).json({ error: 'Invalid principal amount' });
    }

    // Dollars version (for Transaction + disbursedAmount)
    const principalDollars = principalCents / 100;

    // Quick pre-check: lender wallet exists & has balance
    const lenderWallet = await getWalletOrCreate(lenderId);
    if (!lenderWallet) {
      return res
        .status(500)
        .json({ error: 'Wallet not found for lender' });
    }
    if (lenderWallet.availableCents < principalCents) {
      return res.status(400).json({
        error: 'Insufficient wallet balance to fund this loan',
        availableCents: lenderWallet.availableCents,
        requiredCents: principalCents,
      });
    }

    // Single DB transaction: debit lender, credit borrower, mark FUNDED
    await prisma.$transaction(async (tx) => {
      // Re-read lender wallet inside tx
      const w = await tx.wallet.findUnique({
        where: { id: lenderWallet.id },
      });
      if (!w) throw new Error('Wallet not found in transaction.');
      if (w.availableCents < principalCents) {
        throw new Error(
          'Insufficient wallet balance (checked inside transaction).'
        );
      }

      // 1) Debit lender wallet (cents)
      const lenderNewBalance = w.availableCents - principalCents;
      await tx.wallet.update({
        where: { id: w.id },
        data: { availableCents: lenderNewBalance },
      });

      await tx.walletLedger.create({
        data: {
          walletId: w.id,
          type: WalletEntryType.DISBURSE,
          amountCents: principalCents,
          direction: 'DEBIT',
          balanceAfterCents: lenderNewBalance,
          referenceType: 'Loan',
          referenceId: loan.id,
          metadata: {
            reason: 'LOAN_FUNDED_LENDER_DEBIT',
            loanId: loan.id,
            borrowerId: loan.borrowerId,
            lenderId: loan.lenderId,
          },
        },
      });

      // 2) Ensure borrower wallet exists & credit it (cents)
      const borrowerWallet = await tx.wallet.upsert({
        where: { userId: loan.borrowerId },
        update: {},
        create: {
          userId: loan.borrowerId,
          availableCents: 0,
          pendingCents: 0,
        },
      });

      const borrowerNewBalance =
        borrowerWallet.availableCents + principalCents;
      await tx.wallet.update({
        where: { id: borrowerWallet.id },
        data: { availableCents: borrowerNewBalance },
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
            loanId: loan.id,
            borrowerId: loan.borrowerId,
            lenderId: loan.lenderId,
          },
        },
      });

      // 3) BEST-EFFORT Transaction row (dollars, no direction field)
      try {
        await tx.transaction.create({
          data: {
            type: 'DISBURSEMENT',
            amount: principalDollars, // dollars
            loanId: loan.id,
            fromUserId: lenderId,
            toUserId: loan.borrowerId,
          },
        });
      } catch (e) {
        console.warn(
          '⚠️ transaction.create failed (non-fatal):',
          e.message
        );
        // do NOT rethrow – funding should still succeed
      }

      // 4) Mark loan funded (no fundedAt field in your schema)
      await tx.loan.update({
        where: { id: loan.id },
        data: {
          status: 'FUNDED',
          disbursedAmount: principalDollars, // dollars
          updatedAt: new Date(),
        },
      });
    });

    const updated = await prisma.loan.findUnique({
      where: { id: loan.id },
    });

    return res.json({
      ok: true,
      loan: updated,
      disbursement: {
        transferId: 'peerfund-internal-wallet',
        netCents: principalCents,
        platformFeeCents: 0,
      },
    });
  } catch (err) {
    console.error('fundLoanByLender error:', err);
    return res.status(500).json({ error: 'Failed to fund loan' });
  }
};
