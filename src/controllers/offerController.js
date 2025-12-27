const prisma = require('../utils/prisma');


// POST /api/offers/:loanId
exports.submitLoanOffer = async (req, res) => {
  const { loanId } = req.params;
  const { amount, duration, interestRate, message } = req.body;
  const lenderId = req.user.userId;

  if (!amount || !duration || !interestRate) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const offer = await prisma.offer.create({
      data: {
        loanRequestId: loanId,
        lenderId,
        amount: parseFloat(amount),
        duration: parseInt(duration),
        interestRate: parseFloat(interestRate),
        message
      }
    });

    res.status(201).json(offer);
  } catch (err) {
    console.error('Failed to submit loan offer:', err);
    res.status(500).json({ error: 'Error submitting offer' });
  }
};
