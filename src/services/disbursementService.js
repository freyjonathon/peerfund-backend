// src/services/disbursementService.js
require('dotenv').config();

// IMPORTANT: reuse the same prisma instance as the rest of your app
const prisma = require('../utils/prisma');

const { stripe } = require('../lib/stripeIdentities');
const { calcFees } = require('../utils/fees'); // peerfund/banking fee utils

// Wallet helpers
const { WalletEntryType } = require('@prisma/client');
const { getWalletOrCreate } = require('../utils/wallet');

// Platform user that should receive disbursement-time fees
const PLATFORM_USER_ID =
  process.env.PLATFORM_FEE_USER_ID || '68f523b619356751fcb1ed4b';

// Small helper: credit borrower + platform wallets after disbursement
async function applyWalletCreditsForDisbursement({ loanId, borrowerId, netCents, platformFeeCents }) {
  try {
    console.log('💸 applyWalletCreditsForDisbursement', {
      loanId,
      borrowerId,
      netCents,
      platformFeeCents,
    });

    // 1) Borrower wallet gets the net proceeds of the loan
    if (borrowerId && netCents > 0) {
      const borrowerWallet = await getWalletOrCreate(borrowerId);
      const newBal = (borrowerWallet.availableCents || 0) + netCents;

      await prisma.wallet.update({
        where: { id: borrowerWallet.id },
        data: { availableCents: newBal },
      });

      await prisma.walletLedger.create({
        data: {
          walletId: borrowerWallet.id,
          type: WalletEntryType.DISBURSE,      // loan disbursement inflow
          amountCents: netCents,
          direction: 'CREDIT',
          balanceAfterCents: newBal,
          referenceType: 'Loan',
          referenceId: loanId,
          metadata: {
            loanId,
            reason: 'LOAN_DISBURSE_NET',
          },
        },
      });
    }

    // 2) Platform wallet gets the fee portion from this disbursement
    if (PLATFORM_USER_ID && platformFeeCents > 0) {
      const platformWallet = await getWalletOrCreate(PLATFORM_USER_ID);
      const newBal = (platformWallet.availableCents || 0) + platformFeeCents;

      await prisma.wallet.update({
        where: { id: platformWallet.id },
        data: { availableCents: newBal },
      });

      await prisma.walletLedger.create({
        data: {
          walletId: platformWallet.id,
          type: WalletEntryType.ADJUSTMENT,   // generic system credit
          amountCents: platformFeeCents,
          direction: 'CREDIT',
          balanceAfterCents: newBal,
          referenceType: 'Loan',
          referenceId: loanId,
          metadata: {
            loanId,
            reason: 'LOAN_DISBURSE_FEES',
          },
        },
      });
    }
  } catch (e) {
    console.error('⚠️ Failed to apply wallet credits for disbursement:', e);
  }
}

/**
 * Disburse a loan from platform balance to the borrower’s Connect account.
 *
 * Assumes:
 * - Platform already has funds (from lender deposits or float).
 * - Borrower has a Stripe Connect account with payouts enabled enough to accept transfers.
 *
 * Returns:
 *   { ok: true, transferId, netCents, platformFeeCents }
 * or
 *   { ok: false, error }
 */
async function disburseLoanNow(loanId) {
  try {
    // 1) Load loan with borrower & lender
    const loan = await prisma.loan.findUnique({
      where: { id: loanId },
      include: {
        borrower: true,
        lender: true,
      },
    });

    if (!loan) return { ok: false, error: 'Loan not found' };

    // Prefer canonical cents; fall back to float amount
    const principalCents = Number.isFinite(loan.principalCents)
      ? loan.principalCents
      : Math.round((loan.amount || 0) * 100);

    if (!principalCents || principalCents <= 0) {
      return { ok: false, error: 'Invalid principal amount' };
    }

    // Borrower must have a Connect account
    const acctId = loan.borrower?.stripeAccountId;
    if (!acctId) {
      return { ok: false, error: 'Borrower does not have a Stripe Connect account' };
    }

    // (Optional) sanity check account
    try {
      const acct = await stripe.accounts.retrieve(acctId);
      if (!acct?.details_submitted) {
        return { ok: false, error: 'Borrower onboarding incomplete (details_submitted = false)' };
      }
      // If you want to hard-block until payouts_enabled:
      // if (!acct?.payouts_enabled) {
      //   return { ok: false, error: 'Payouts not enabled on borrower account' };
      // }
    } catch (e) {
      return {
        ok: false,
        error: `Failed to retrieve connect account: ${e?.message || String(e)}`,
      };
    }

    // 2) Compute upfront fees using your helper (values in dollars)
    const dollars = principalCents / 100;
    const { peerfundFee, bankingFee, totalFees } = calcFees(dollars);

    const platformFeeCents = Math.round(totalFees * 100);
    const netCents = principalCents - platformFeeCents;
    if (netCents <= 0) {
      return { ok: false, error: 'Fees exceed or equal principal, cannot disburse' };
    }

    // 3) Create Stripe transfer from PLATFORM balance → borrower connected account
    const transferGroup = `loan_${loan.id}`;
    let transfer;
    try {
      transfer = await stripe.transfers.create({
        amount: netCents,
        currency: 'usd',
        destination: acctId,
        transfer_group: transferGroup,
        metadata: {
          loanId: loan.id,
          borrowerId: loan.borrowerId,
          lenderId: loan.lenderId,
          platformFeeCents: String(platformFeeCents),
        },
      });
    } catch (e) {
      return { ok: false, error: `Stripe transfer failed: ${e?.message || String(e)}` };
    }

    const fundedAt = new Date();
    const disbursedAmount = dollars - platformFeeCents / 100; // in dollars

    // 4) Persist loan + ledger entries + transaction in ONE transaction
    await prisma.$transaction(async (tx) => {
      await tx.loan.update({
        where: { id: loan.id },
        data: {
          transferGroup,
          status: 'FUNDED',
          fundedDate: fundedAt,      // or fundedAt, depending on your schema
          platformFeeCents,
          disbursedAmount,
          peerfundFee,              // keep legacy float fields for UI if you still have them
          bankingFee,
          totalFees,
          updatedAt: fundedAt,
        },
      });

      // Platform-level ledger entries (if you still use ledgerEntry)
      await tx.ledgerEntry.createMany({
        data: [
          {
            loanId: loan.id,
            type: 'DISBURSE',
            amountCents: netCents,
            currency: 'usd',
            direction: 'debit',
            stripeXferId: transfer.id,
            meta: { borrowerAccount: acctId },
          },
          {
            loanId: loan.id,
            type: 'FEE',
            amountCents: platformFeeCents,
            currency: 'usd',
            direction: 'credit',
            meta: { breakdown: { peerfundFee, bankingFee } },
          },
        ],
      });

      // Transaction history line so it appears in Transaction History UI
      await tx.transaction.create({
        data: {
          type: 'DISBURSEMENT',
          fromUserId: loan.lenderId,
          toUserId: loan.borrowerId,
          loanId: loan.id,
          amount: disbursedAmount,        // dollars
          peerfundFee,
          bankingFee,
          processedAt: fundedAt,
          timestamp: fundedAt,
        },
      });
    });

    // 5) Apply wallet credits for borrower + platform
    await applyWalletCreditsForDisbursement({
      loanId: loan.id,
      borrowerId: loan.borrowerId,
      netCents,
      platformFeeCents,
    });

    return { ok: true, transferId: transfer.id, netCents, platformFeeCents };
  } catch (err) {
    console.error('disburseLoanNow error:', err);
    return { ok: false, error: err?.message || 'Unknown error during disbursement' };
  }
}

module.exports = {
  disburseLoanNow,
};
