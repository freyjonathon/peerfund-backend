// src/services/feeRoutingService.js
const prisma = require('../utils/prisma');
const { getWalletOrCreate } = require('../utils/wallet');

const PLATFORM_FEE_USER_ID = process.env.PLATFORM_FEE_USER_ID || null;
const BANK_FEE_USER_ID     = process.env.BANK_FEE_USER_ID || null;

/**
 * Route peerfundFeeCents and bankingFeeCents to the appropriate wallets.
 *
 * - sourceUserId: who is paying the fee (typically borrower on repayment,
 *   or borrower/lender on some flows)
 * - loanId / repaymentId: for linking back to the loan/repayment
 * - peerfundFeeCents: platform fee portion in cents
 * - bankingFeeCents: bank/Stripe fee portion in cents
 */
async function routeFeesToSystemAccounts({
  sourceUserId,
  loanId,
  repaymentId = null,
  peerfundFeeCents = 0,
  bankingFeeCents = 0,
}) {
  // Nothing to do
  if (!peerfundFeeCents && !bankingFeeCents) return;

  await prisma.$transaction(async (tx) => {
    // ADMIN / PLATFORM FEE → PLATFORM_FEE_USER_ID
    if (peerfundFeeCents > 0 && PLATFORM_FEE_USER_ID) {
      const platformWallet = await getWalletOrCreate(PLATFORM_FEE_USER_ID, tx);

      // Credit platform wallet
      await tx.wallet.update({
        where: { id: platformWallet.id },
        data: { availableCents: { increment: peerfundFeeCents } },
      });

      await tx.walletLedger.create({
        data: {
          walletId: platformWallet.id,
          type: 'FEE',                  // WalletEntryType
          amountCents: peerfundFeeCents,
          direction: 'CREDIT',
          balanceAfterCents: platformWallet.availableCents + peerfundFeeCents,
          referenceType: 'ADMIN_FEE',
          referenceId: loanId,
          metadata: {
            kind: 'ADMIN_FEE',
            loanId,
            repaymentId,
          },
        },
      });

      // Optional: create a Transaction row of type ADMIN_FEE
      await tx.transaction.create({
        data: {
          type: 'ADMIN_FEE',
          fromUserId: sourceUserId,
          toUserId: PLATFORM_FEE_USER_ID,
          loanId,
          repaymentId,
          amount: peerfundFeeCents / 100,
          peerfundFee: peerfundFeeCents / 100,
          bankingFee: 0,
        },
      });
    }

    // BANK FEE → BANK_FEE_USER_ID
    if (bankingFeeCents > 0 && BANK_FEE_USER_ID) {
      const bankWallet = await getWalletOrCreate(BANK_FEE_USER_ID, tx);

      await tx.wallet.update({
        where: { id: bankWallet.id },
        data: { availableCents: { increment: bankingFeeCents } },
      });

      await tx.walletLedger.create({
        data: {
          walletId: bankWallet.id,
          type: 'FEE',
          amountCents: bankingFeeCents,
          direction: 'CREDIT',
          balanceAfterCents: bankWallet.availableCents + bankingFeeCents,
          referenceType: 'BANK_FEE',
          referenceId: loanId,
          metadata: {
            kind: 'BANK_FEE',
            loanId,
            repaymentId,
          },
        },
      });

      await tx.transaction.create({
        data: {
          type: 'BANK_FEE',
          fromUserId: sourceUserId,
          toUserId: BANK_FEE_USER_ID,
          loanId,
          repaymentId,
          amount: bankingFeeCents / 100,
          peerfundFee: 0,
          bankingFee: bankingFeeCents / 100,
        },
      });
    }
  });
}

module.exports = {
  routeFeesToSystemAccounts,
};
