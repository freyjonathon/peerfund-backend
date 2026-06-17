require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const {
  stripe,
  ensureStripeCustomerFor,
  ensureConnectAccountFor,
} = require('../lib/stripeIdentities');

const { computePlatformFeeCentsFromBase } = require('../utils/fees');

function getAuthedUserId(req) {
  return req.user?.userId || req.user?.id || null;
}

// POST /api/loans/:loanId/fund
exports.fundLoan = async (req, res) => {
  try {
    console.log('⚠️ legacy loanFundingController.fundLoan hit');

    const callerId = getAuthedUserId(req);
    if (!callerId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { loanId } = req.params;

    const loan = await prisma.loan.findUnique({
      where: { id: loanId },
    });

    if (!loan) {
      return res.status(404).json({ error: 'Loan not found' });
    }

    if (String(loan.lenderId) !== String(callerId)) {
      return res.status(403).json({
        error: 'Only the lender can fund this loan',
      });
    }

    const status = (loan.status || '').toUpperCase();

    if (status !== 'ACCEPTED') {
      return res.status(400).json({
        error: 'Loan is not ready to fund. Status must be ACCEPTED.',
      });
    }

    const lender = await prisma.user.findUnique({
      where: { id: loan.lenderId },
    });

    const borrower = await prisma.user.findUnique({
      where: { id: loan.borrowerId },
    });

    if (!lender || !borrower) {
      return res.status(404).json({
        error: 'Borrower or lender not found',
      });
    }

    const savedAch = await prisma.paymentMethod.findFirst({
      where: {
        userId: loan.lenderId,
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
        bankName: true,
        last4: true,
        type: true,
      },
    });

    console.log('🏦 legacy lender ACH lookup result', {
      lenderId: loan.lenderId,
      found: !!savedAch,
      bankName: savedAch?.bankName,
      last4: savedAch?.last4,
      stripePaymentMethodId: savedAch?.stripePaymentMethodId,
    });

    if (!savedAch?.stripePaymentMethodId) {
      return res.status(400).json({
        code: 'MISSING_LENDER_ACH_METHOD',
        error: 'Please link a bank account before funding this loan.',
      });
    }

    let customerId =
      savedAch.stripeCustomerId ||
      lender.stripeCustomerId ||
      null;

    if (!customerId) {
      customerId = await ensureStripeCustomerFor(prisma, lender);
    }

    const accountId = borrower.stripeAccountId
      ? borrower.stripeAccountId
      : await ensureConnectAccountFor(prisma, borrower);

    const principalCents = Number.isFinite(loan.principalCents)
      ? loan.principalCents
      : Math.round((Number(loan.amount || 0)) * 100);

    if (!principalCents || principalCents <= 0) {
      return res.status(400).json({ error: 'Invalid loan amount' });
    }

    const transferGroup = `loan_${loan.id}`;

    const platformFeeCents = computePlatformFeeCentsFromBase(
      principalCents / 100,
      borrower,
      lender
    );

    console.log('🧾 legacy Creating ACH loan funding PaymentIntent', {
      loanId: loan.id,
      lenderId: lender.id,
      borrowerId: borrower.id,
      principalCents,
      customerId,
      paymentMethodId: savedAch.stripePaymentMethodId,
      paymentMethodType: 'us_bank_account',
    });

    const pi = await stripe.paymentIntents.create(
      {
        amount: principalCents,
        currency: 'usd',
        customer: customerId,
        payment_method: savedAch.stripePaymentMethodId,
        payment_method_types: ['us_bank_account'],
        confirm: true,
        off_session: true,
        description: `PeerFund loan ${loan.id}`,
        transfer_group: transferGroup,
        metadata: {
          purpose: 'LOAN_FUNDING_LEGACY_CONTROLLER',
          loanId: loan.id,
          borrowerId: borrower.id,
          lenderId: lender.id,
          principalCents: String(principalCents),
          paymentMethodSource: 'SAVED_ACH_ONLY',
        },
      },
      {
        idempotencyKey: `peerfund-legacy-loan-funding-${loan.id}-${savedAch.stripePaymentMethodId}`,
      }
    );

    console.log('✅ legacy Stripe funding result', {
      paymentIntentId: pi.id,
      status: pi.status,
      amount: pi.amount,
      currency: pi.currency,
    });

    await prisma.loan.update({
      where: { id: loan.id },
      data: {
        paymentIntentId: pi.id,
        transferGroup,
        platformFeeCents,
        status: pi.status === 'succeeded' ? 'FUNDED' : 'PROCESSING',
        updatedAt: new Date(),
      },
    });

    return res.json({
      ok: true,
      paymentIntentId: pi.id,
      status: pi.status,
      client_secret: pi.client_secret,
    });
  } catch (err) {
    console.error('legacy fundLoan error', {
      message: err?.message,
      code: err?.code,
      rawCode: err?.raw?.code,
      rawMessage: err?.raw?.message,
      type: err?.type,
    });

    return res.status(400).json({
      code: err?.code || err?.raw?.code || 'FUNDING_FAILED',
      error:
        err?.raw?.message ||
        err?.message ||
        'Funding failed to start',
    });
  }
};