// src/controllers/repaymentController.js
const prisma = require('../utils/prisma');
const { PEERFUND_FEE_RATE, BANKING_FEE_RATE, calcFees } = require('../utils/fees');
const { WalletEntryType } = require('@prisma/client');
const { getWalletOrCreate } = require('../utils/wallet');

// Platform user that receives platform + bank fees
const PLATFORM_USER_ID =
  process.env.PLATFORM_FEE_USER_ID || '68f523b619356751fcb1ed4b';

// helper: round to 2 decimals
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// helper: push repayment money into wallets (lender + platform)
async function applyWalletCreditsForRepayment({ loan, loanId, base, bankingFee, platformFee }) {
  try {
    const lenderId = loan?.lender?.id;

    console.log('💸 applyWalletCreditsForRepayment', {
      loanId,
      lenderId,
      base,
      bankingFee,
      platformFee,
    });

    const baseCents     = Math.round((Number(base)        || 0) * 100);
    const bankCents     = Math.round((Number(bankingFee)  || 0) * 100);
    const platformCents = Math.round((Number(platformFee) || 0) * 100);
    const totalFeeCents = bankCents + platformCents;

    // 1) Credit lender wallet with base repayment
    if (lenderId && baseCents > 0) {
      const lenderWallet = await getWalletOrCreate(lenderId);
      const newBal = (lenderWallet.availableCents || 0) + baseCents;

      await prisma.wallet.update({
        where: { id: lenderWallet.id },
        data: { availableCents: newBal },
      });

      await prisma.walletLedger.create({
        data: {
          walletId: lenderWallet.id,
          type: WalletEntryType.DISBURSE, // reuse DISBURSE for loan-related inflow
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

    // 2) Credit platform wallet with BANK_FEE + PLATFORM_FEE
    if (PLATFORM_USER_ID && totalFeeCents > 0) {
      const platformWallet = await getWalletOrCreate(PLATFORM_USER_ID);
      const newBal = (platformWallet.availableCents || 0) + totalFeeCents;

      await prisma.wallet.update({
        where: { id: platformWallet.id },
        data: { availableCents: newBal },
      });

      await prisma.walletLedger.create({
        data: {
          walletId: platformWallet.id,
          type: WalletEntryType.ADJUSTMENT, // generic “system” credit
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
  } catch (e) {
    console.error('⚠️ Failed to apply wallet credits for repayment:', e);
  }
}

// GET /api/repayments/:loanId – List repayments
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

// PUT /api/repayments/record/:repaymentId – Manual entry (admin/testing)
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

/**
 * POST /api/repayments/:loanId
 * Borrower makes a payment for the NEXT pending installment (manual amount path)
 */
exports.makeRepayment = async (req, res) => {
  const userId = req.user.userId;
  const { loanId } = req.params;
  const { amount } = req.body;

  try {
    // NOTE: use select so Prisma does NOT try to load interestRateBps/principalCents
    const loan = await prisma.loan.findUnique({
      where: { id: loanId },
      select: {
        id: true,
        borrowerId: true,
        borrower: { select: { id: true, isSuperUser: true } },
        lender:   { select: { id: true } },
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

    // Base for this installment
    const base = Number(nextRepayment.basePayment) || 0;

    // Compute fees from helper
    let { peerfundFee, bankingFee, totalFees, totalCharge } = calcFees(base);

    // Super users bypass PeerFund fee
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
        error: `Minimum payment is $${totalCharge.toFixed(
          2
        )}. Your payment: $${paymentAmount.toFixed(2)}`,
      });
    }

    // ── 1) Mark repayment as paid (MVP: no real gateway call yet) ─────────
    const paidAt = new Date();
    const updated = await prisma.repayment.update({
      where: { id: nextRepayment.id },
      data: {
        amountPaid: paymentAmount,
        basePayment: base,
        bankingFee: r2(bankingFee),
        peerfundFee: r2(peerfundFee),
        totalCharged: r2(totalCharge),
        status: 'PAID',
        paidAt,
      },
    });

    // Normalize final fee values we’ll use for accounting
    const finalBanking = r2(bankingFee);
    const finalPeerfund = r2(peerfundFee);

    // ── 2) Fee audit rows (existing fee table) ────────────────────────────
    try {
      const feeRecords = [];
      if (finalBanking > 0) {
        feeRecords.push({
          loanId,
          repaymentId: updated.id,
          type: 'BANK_FEE',
          amount: finalBanking,
        });
      }
      if (finalPeerfund > 0) {
        feeRecords.push({
          loanId,
          repaymentId: updated.id,
          type: 'PLATFORM_FEE',
          amount: finalPeerfund,
        });
      }
      if (feeRecords.length) {
        await prisma.fee.createMany({ data: feeRecords });
      }
    } catch (e) {
      console.error('⚠️ Failed to log fees into fee table:', e);
    }

    // ── 3) Transactions for history & accounting ──────────────────────────
    try {
      const txRows = [];

      // a) REPAYMENT → lender (base amount only)
      if (loan.lender?.id) {
        txRows.push({
          type: 'REPAYMENT',
          amount: r2(base),
          fromUserId: loan.borrowerId,
          toUserId: loan.lender.id,
          loanId,
        });
      }

      // b) BANK_FEE → platform
      if (finalBanking > 0) {
        txRows.push({
          type: 'BANK_FEE',
          amount: finalBanking,
          fromUserId: loan.borrowerId,
          toUserId: PLATFORM_USER_ID,
          loanId,
        });
      }

      // c) PLATFORM_FEE → platform
      if (finalPeerfund > 0) {
        txRows.push({
          type: 'PLATFORM_FEE',
          amount: finalPeerfund,
          fromUserId: loan.borrowerId,
          toUserId: PLATFORM_USER_ID,
          loanId,
        });
      }

      if (txRows.length) {
        await prisma.transaction.createMany({ data: txRows });
      }
    } catch (e) {
      console.error('⚠️ Failed to log repayment transactions:', e);
    }

    // ── 4) Wallet credits: lender base + platform fees ────────────────────
    await applyWalletCreditsForRepayment({
      loan,
      loanId,
      base,
      bankingFee: finalBanking,
      platformFee: finalPeerfund,
    });

    res.status(200).json({
      message: 'Repayment submitted successfully',
      amountPaid: paymentAmount,
      breakdown: {
        base,
        bankingFee: finalBanking,
        peerfundFee: finalPeerfund,
        total: r2(totalCharge),
      },
    });
  } catch (err) {
    console.error('💥 makeRepayment error:', err);
    res.status(500).json({ error: 'Failed to submit repayment' });
  }
};

/**
 * POST /api/loans/:loanId/pay-next
 * Borrower pays the NEXT pending installment (no amount in body).
 * Body may optionally include { paymentSource: 'wallet' | 'bank' }.
 */
exports.payNextRepayment = async (req, res) => {
  try {
    const borrowerId = req.user.userId;
    const { loanId } = req.params;
    const { paymentSource = 'wallet' } = req.body || {}; // default wallet

    console.log('🔔 payNextRepayment called', { loanId, borrowerId, paymentSource });

    // 1) Validate borrower owns this loan – ONLY select what we actually need
    const loan = await prisma.loan.findFirst({
      where: { id: loanId, borrowerId },
      select: {
        id: true,
        borrowerId: true,
        lenderId: true,
        borrower: { select: { isSuperUser: true } },
        lender:   { select: { id: true } },
      },
    });

    if (!loan) {
      console.warn('payNextRepayment: loan not found or not owned by borrower', { loanId, borrowerId });
      return res.status(404).json({ error: 'Loan not found' });
    }

    // 2) Next pending repayment
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
      console.warn('payNextRepayment: no pending repayment', { loanId });
      return res.status(400).json({ error: 'No pending repayment' });
    }

    // 3) Compute fees from base or reuse persisted values
    const base = Number(next.basePayment) || 0;
    let { peerfundFee, bankingFee, totalFees, totalCharge } = calcFees(base);

    if (loan.borrower.isSuperUser) {
      peerfundFee = 0;
      totalFees   = r2(bankingFee + peerfundFee);
      totalCharge = r2(base + totalFees);
    }

    const finalPeerfund =
      typeof next.peerfundFee === 'number' ? next.peerfundFee : r2(peerfundFee);
    const finalBanking =
      typeof next.bankingFee === 'number' ? next.bankingFee : r2(bankingFee);
    const finalTotal =
      typeof next.totalCharged === 'number'
        ? next.totalCharged
        : r2(base + finalPeerfund + finalBanking);

    console.log('💳 Computed installment amounts', {
      base,
      finalBanking,
      finalPeerfund,
      finalTotal,
      paymentSource,
    });

    // 4) If paying with bank, ensure a default payment method exists
    let paymentMethodId = null;
    if (paymentSource === 'bank') {
      const pm = await prisma.paymentMethod.findFirst({
        where: { userId: borrowerId, isDefault: true },
        select: { id: true },
      });
      if (!pm) {
        console.warn('payNextRepayment: no default payment method for bank source', { borrowerId });
        return res.status(400).json({ error: 'No payment method on file' });
      }
      paymentMethodId = pm.id;
    }

    // 5) CHARGE (MVP): mark repayment as paid
    const paidAt = new Date();
    const updated = await prisma.repayment.update({
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

    // 6) Fee audit rows
    try {
      const feeRecords = [];
      if (finalBanking > 0) {
        feeRecords.push({
          loanId,
          repaymentId: next.id,
          type: 'BANK_FEE',
          amount: r2(finalBanking),
        });
      }
      if (finalPeerfund > 0) {
        feeRecords.push({
          loanId,
          repaymentId: next.id,
          type: 'PLATFORM_FEE',
          amount: r2(finalPeerfund),
        });
      }
      if (feeRecords.length) {
        await prisma.fee.createMany({ data: feeRecords });
      }
    } catch (e) {
      console.error('⚠️ Failed to log fees (payNextRepayment):', e);
    }

    // 7) Transactions + wallet logic
    try {
      const txRows = [];

      // a) REPAYMENT → lender (base amount)
      if (loan.lender?.id && base > 0) {
        txRows.push({
          type: 'REPAYMENT',
          amount: r2(base),
          fromUserId: borrowerId,
          toUserId:   loan.lender.id,
          loanId,
        });
      }

      // b) BANK_FEE → platform
      if (finalBanking > 0) {
        txRows.push({
          type: 'BANK_FEE',
          amount: r2(finalBanking),
          fromUserId: borrowerId,
          toUserId:   PLATFORM_USER_ID,
          loanId,
        });
      }

      // c) PLATFORM_FEE → platform
      if (finalPeerfund > 0) {
        txRows.push({
          type: 'PLATFORM_FEE',
          amount: r2(finalPeerfund),
          fromUserId: borrowerId,
          toUserId:   PLATFORM_USER_ID,
          loanId,
        });
      }

      if (txRows.length) {
        await prisma.transaction.createMany({ data: txRows });
      }

      // WALLET LOGIC
      if (paymentSource === 'wallet') {
        const totalCents = Math.round(finalTotal * 100);

        const borrowerWallet = await getWalletOrCreate(borrowerId);
        if (!borrowerWallet || borrowerWallet.availableCents < totalCents) {
          console.warn('payNextRepayment: insufficient wallet balance', {
            borrowerId,
            available: borrowerWallet?.availableCents,
            required: totalCents,
          });
          return res.status(400).json({ error: 'Insufficient wallet balance' });
        }

        const newBorrowerBal = borrowerWallet.availableCents - totalCents;
        await prisma.wallet.update({
          where: { id: borrowerWallet.id },
          data: { availableCents: newBorrowerBal },
        });

        await prisma.walletLedger.create({
          data: {
            walletId: borrowerWallet.id,
            type: WalletEntryType.REPAYMENT,
            amountCents: totalCents,
            direction: 'DEBIT',
            balanceAfterCents: newBorrowerBal,
            referenceType: 'Loan',
            referenceId: loanId,
            metadata: {
              loanId,
              repaymentId: next.id,
              reason: 'REPAYMENT_DEBIT',
              source: 'WALLET',
            },
          },
        });

        await applyWalletCreditsForRepayment({
          loan,
          loanId,
          base,
          bankingFee: finalBanking,
          platformFee: finalPeerfund,
        });
      } else {
        await applyWalletCreditsForRepayment({
          loan,
          loanId,
          base,
          bankingFee: finalBanking,
          platformFee: finalPeerfund,
        });
      }
    } catch (e) {
      console.error('⚠️ Failed to log repayment transactions/wallet movements:', e);
    }

    // ---------------------------------------------------------------------
    // 8) NEW — If no pending repayments remain, mark loan as PAID_OFF
    // ---------------------------------------------------------------------
    try {
      const remaining = await prisma.repayment.count({
        where: { loanId, status: 'PENDING' },
      });

      if (remaining === 0) {
        console.log(`🎉 Loan ${loanId} fully repaid — marking PAID_OFF`);
        await prisma.loan.update({
          where: { id: loanId },
          data: {
            status: 'PAID_OFF',
            // If you add this column later:
            // paidOffAt: new Date(),
          },
        });
      }
    } catch (e) {
      console.error('⚠️ Failed to mark loan as PAID_OFF:', e);
    }
    // ---------------------------------------------------------------------

    return res.json({
      ok: true,
      repaymentId: updated.id,
      status: updated.status,
      paidAt: updated.paidAt,
      amount: updated.totalCharged,
    });
  } catch (err) {
    console.error('💥 payNextRepayment error:', err);
    return res.status(500).json({ error: 'Payment failed' });
  }
};
