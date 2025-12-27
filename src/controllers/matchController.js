const prisma = require('../utils/prisma');

const getMatchingLoans = async (req, res) => {
  const { maxLoanAmount, loanDurationMonths, purposes } = req.query;

  try {
    const matching = await prisma.loanRequest.findMany({
      where: {
        status: 'OPEN',
        amount: { lte: Number(maxLoanAmount) },
        duration: Number(loanDurationMonths),
        reason: { in: purposes.split(',') }
      },
      include: { borrower: true }
    });

    res.status(200).json(matching);
  } catch (err) {
    console.error('Error matching loans:', err);
    res.status(500).json({ error: 'Failed to fetch matches' });
  }
};

module.exports = { getMatchingLoans };
