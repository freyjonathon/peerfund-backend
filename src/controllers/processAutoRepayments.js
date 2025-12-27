// /cron/processAutoRepayments.js
const prisma = require('../utils/prisma');
const { calcFees } = require('../utils/fees');
// If you have a processor util that actually moves money, keep it;
// otherwise the controller can directly mark the repayment as paid.
// const { processPayment } = require('../utils/paymentProcessor');

// Platform user that receives platform + bank fees
const PLATFORM_USER_ID =
  process.env.PLATFORM_FEE_USER_ID || '68f523b619356751fcb1ed4b';

// helper: round to 2 decimals
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

async function runAutoRepayments() {
  const today = new Date();

  const dueRepayments = await prisma.repayment.findMany({
    where: {
      status: 'PENDING',
      dueDate: { lte: today },
    },
    include: {
      loan: {
        include: {
          borrower: { select: { id: true, name: true, isSuperUser: true } },
          lender:   { select: { id: true, name: true, isSuperUser: true } },
        },
      },
    },
  });

  console.log(`🔄 Found ${dueRepayments.length} due repayments to process`);

  for (const repayment of dueRepayments) {
    const { loan, id: repaymentId, loanId } = repayment;
    const base = Number(repayment.basePayment) || Number(repayment.amountDue) || 0;

    // Compute fees
    let { peerfundFee, bankingFee, totalCharge } = calcFees(base);
    if (loan.borrower.isSuperUser) {
      // super users skip PF fee
      peerfundFee = 0;
      totalCharge = r2(base + bankingFee);
    }

    const finalBanking  = r2(bankingFee);
    const finalPeerfund = r2(peerfundFee);
    const finalTotal    = r2(base + finalBanking + finalPeerfund);

    try {
      // If you have an actual ACH debit flow here, call it. For MVP we just mark paid.
      // await processPayment({...})

      // 1) Mark repayment as paid & persist fee breakdown
      const paidAt = new Date();
      await prisma.repayment.update({
        where: { id: repaymentId },
        data: {
          status: 'PAID',
          paidAt,
          basePayment: base,
          peerfundFee: finalPeerfund,
          bankingFee: finalBanking,
          totalCharged: finalTotal,
          amountPaid: finalTotal,
        },
      });

      // 2) Fee audit rows (PLATFORM_FEE, BANK_FEE)
      const feeRows = [];
      if (finalBanking > 0) {
        feeRows.push({
          loanId,
          repaymentId,
          type: 'BANK_FEE',
          amount: finalBanking,
        });
      }
      if (finalPeerfund > 0) {
        feeRows.push({
          loanId,
          repaymentId,
          type: 'PLATFORM_FEE',
          amount: finalPeerfund,
        });
      }
      if (feeRows.length) {
        await prisma.fee.createMany({ data: feeRows });
      }

      // 3) Transaction rows for accounting / UI
      try {
        const txRows = [];

        // a) REPAYMENT → lender (base only)
        if (loan.lender?.id) {
          txRows.push({
            type: 'REPAYMENT',
            amount: r2(base),
            fromUserId: loan.borrower.id,
            toUserId:   loan.lender.id,
            loanId,
          });
        }

        // b) BANK_FEE → platform
        if (finalBanking > 0) {
          txRows.push({
            type: 'BANK_FEE',
            amount: finalBanking,
            fromUserId: loan.borrower.id,
            toUserId:   PLATFORM_USER_ID,
            loanId,
          });
        }

        // c) PLATFORM_FEE → platform
        if (finalPeerfund > 0) {
          txRows.push({
            type: 'PLATFORM_FEE',
            amount: finalPeerfund,
            fromUserId: loan.borrower.id,
            toUserId:   PLATFORM_USER_ID,
            loanId,
          });
        }

        if (txRows.length) {
          await prisma.transaction.createMany({ data: txRows });
        }
      } catch (txErr) {
        console.error(
          `⚠️ Failed to create transaction rows for repayment ${repaymentId}:`,
          txErr.message || txErr
        );
      }

      console.log(`✅ Auto-processed repayment ${repaymentId} for loan ${loanId}`);
    } catch (err) {
      console.error(`❌ Failed to auto-process repayment ${repaymentId}:`, err.message);
    }
  }
}

module.exports = runAutoRepayments;
