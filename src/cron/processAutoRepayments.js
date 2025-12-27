const prisma = require('../utils/prisma');
const { differenceInDays } = require('date-fns');

async function runAutoRepayments() {
  console.log('⏰ Running auto-repayment job...');

  const today = new Date();

  const repayments = await prisma.repayment.findMany({
    where: {
      dueDate: {
        lte: today,
      },
      status: 'PENDING',
      autopayAttempted: false,
    },
    include: {
      loan: true,
    },
  });

  for (const repayment of repayments) {
    const borrower = await prisma.user.findUnique({
      where: { id: repayment.loan.borrowerId },
    });

    if (!borrower.bankAccountId) {
      console.warn(`🚫 Skipping ${repayment.id} — no bank info.`);
      continue;
    }

    try {
      // ❗ Replace with real Stripe/Dwolla call
      console.log(`💸 Simulating ACH pull for $${repayment.amountDue} from user ${borrower.id}`);

      await prisma.repayment.update({
        where: { id: repayment.id },
        data: {
          autopayAttempted: true,
          autopaySuccess: true,
          status: 'PAID',
          amountPaid: repayment.amountDue,
          paidAt: new Date(),
        },
      });
    } catch (err) {
      console.error('❌ ACH payment failed:', err.message);
      await prisma.repayment.update({
        where: { id: repayment.id },
        data: {
          autopayAttempted: true,
          autopaySuccess: false,
          failReason: err.message,
        },
      });
    }
  }

  console.log(`✅ Finished processing ${repayments.length} repayments.`);
}

module.exports = runAutoRepayments;
