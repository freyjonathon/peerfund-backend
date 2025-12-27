require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const { stripe, ensureStripeCustomerFor, ensureConnectAccountFor } = require('../lib/stripeIdentities');
const { computePlatformFeeCentsFromBase } = require('../utils/fees');

// POST /api/loans/:loanId/fund
// body: { paymentMethodId: 'pm_xxx' }  // borrower's us_bank_account PM (from Financial Connections)
exports.fundLoan = async (req, res) => {
  try {
    const { loanId } = req.params;
    const { paymentMethodId } = req.body;
    if (!paymentMethodId) return res.status(400).json({ error: 'Missing paymentMethodId' });

    // borrower must be the caller
    const loan = await prisma.loan.findUnique({ where: { id: loanId } });
    if (!loan) return res.status(404).json({ error: 'Loan not found' });
    if (loan.borrowerId !== req.user.id) return res.status(403).json({ error: 'Only borrower can fund this loan' });

    const borrower = await prisma.user.findUnique({ where: { id: loan.borrowerId } });
    const lender   = await prisma.user.findUnique({ where: { id: loan.lenderId } });

    const customerId = await ensureStripeCustomerFor(prisma, borrower);
    const accountId  = await ensureConnectAccountFor(prisma, lender);

    const transferGroup = `loan_${loan.id}`;
    const platformFeeCents = computePlatformFeeCentsFromBase(
    loan.principalCents / 100, // convert cents → dollars for your current calc
    borrower, lender
);


    const pi = await stripe.paymentIntents.create({
      amount: loan.principalCents,
      currency: 'usd',
      customer: customerId,
      payment_method: paymentMethodId,
      payment_method_types: ['us_bank_account'],
      confirmation_method: 'automatic',
      confirm: true,
      description: `PeerFund loan ${loan.id}`,
      transfer_group: transferGroup,
      application_fee_amount: platformFeeCents,
      on_behalf_of: accountId,
      transfer_data: { destination: accountId },
      metadata: { loanId: loan.id, borrowerId: borrower.id, lenderId: lender.id },
    });

    await prisma.loan.update({
      where: { id: loan.id },
      data: {
        paymentIntentId: pi.id,
        transferGroup,
        platformFeeCents,
        status: 'PROCESSING',
      },
    });

    return res.json({ paymentIntentId: pi.id, client_secret: pi.client_secret });
  } catch (err) {
    console.error('fundLoan error', err);
    return res.status(500).json({ error: 'Funding failed to start' });
  }
};
