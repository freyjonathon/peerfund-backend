// src/controllers/userLoanController.js
const prisma = require('../utils/prisma');

exports.getMoneySummary = async (req, res) => {
  const userId = req.user.userId;

  try {
    // 1) Loans where the user is the LENDER
    const loansGivenRaw = await prisma.loan.findMany({
      where: { lenderId: userId },
      select: {
        id: true,
        status: true,
        fundedDate: true,          // existing field
        amount: true,
        principalCents: true,
        duration: true,            // we’ll rely on this for “months”
        interestRate: true,
        borrower: {
          select: {
            id: true,
            name: true,
            isSuperUser: true,
          },
        },
        repayments: {
          where: { status: 'PENDING' },
          orderBy: { dueDate: 'asc' },
          take: 1,
          select: {
            id: true,
            dueDate: true,
            basePayment: true,
            bankingFee: true,
            peerfundFee: true,
            totalCharged: true,
            status: true,
          },
        },
        documents: {
          where: { type: 'contract' },
          select: { id: true },
          take: 1,
        },
      },
    });

    // 2) Loans where the user is the BORROWER
    const loansReceivedRaw = await prisma.loan.findMany({
      where: { borrowerId: userId },
      select: {
        id: true,
        status: true,
        fundedDate: true,
        amount: true,
        principalCents: true,
        duration: true,
        interestRate: true,
        lender: {
          select: {
            id: true,
            name: true,
          },
        },
        repayments: {
          where: { status: 'PENDING' },
          orderBy: { dueDate: 'asc' },
          take: 1,
          select: {
            id: true,
            dueDate: true,
            basePayment: true,
            bankingFee: true,
            peerfundFee: true,
            totalCharged: true,
            status: true,
          },
        },
        documents: {
          where: { type: 'contract' },
          select: { id: true },
          take: 1,
        },
      },
    });

    const shapeLoan = (loan, role /* 'LENDER' | 'BORROWER' */) => {
      const next = Array.isArray(loan.repayments)
        ? loan.repayments[0]
        : undefined;

      const base = Number(next?.basePayment ?? 0);
      const bank = Number(next?.bankingFee ?? 0);
      const pf = Number(next?.peerfundFee ?? 0);
      const total = Number(
        next?.totalCharged ??
          (base + bank + pf)
      );

      // Prefer canonical cents if amount is missing
      const amount =
        loan.amount != null
          ? Number(loan.amount)
          : loan.principalCents != null
          ? Number(loan.principalCents) / 100
          : 0;

      const duration =
        loan.duration != null ? Number(loan.duration) : 0;

      return {
        id: loan.id,
        status: loan.status || 'OPEN',          // used by MoneySummary for badges/buttons
        amount,
        interestRate:
          loan.interestRate != null
            ? Number(loan.interestRate)
            : null,
        duration,

        lenderName:
          role === 'BORROWER'
            ? loan.lender?.name ?? null
            : null,
        borrowerName:
          role === 'LENDER'
            ? loan.borrower?.name ?? null
            : null,

        nextDueDate: next?.dueDate
          ? new Date(next.dueDate).toISOString()
          : null,
        installmentAmount: base,
        bankingFee: bank,
        peerfundFee: pf,
        totalDue: total,

        fundedDate: loan.fundedDate || null,
        contractDocumentId: loan.documents?.[0]?.id ?? null,
      };
    };

    res.status(200).json({
      loansGiven: loansGivenRaw.map((l) => shapeLoan(l, 'LENDER')),
      loansReceived: loansReceivedRaw.map((l) => shapeLoan(l, 'BORROWER')),
    });
  } catch (err) {
    console.error('Error building money summary:', err);
    res.status(500).json({ error: 'Could not load money summary' });
  }
};
