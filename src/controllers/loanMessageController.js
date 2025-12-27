const prisma = require('../utils/prisma');

// GET /api/loan-messages/:loanId
exports.getLoanMessages = async (req, res) => {
  const { loanId } = req.params;
  try {
    const loan = await prisma.loan.findUnique({ where: { id: loanId }, select: { id: true }});
    if (!loan) return res.status(404).json({ error: 'Loan not found' });

    const messages = await prisma.loanMessage.findMany({
      where: { loanId },
      include: {
        user: { select: { id: true, name: true } },   // ✅ user, not sender
      },
      orderBy: { createdAt: 'asc' }
    });

    res.json(messages);
  } catch (e) {
    console.error('getLoanMessages error:', e);
    res.status(500).json({ error: 'Could not fetch messages' });
  }
};

// POST /api/loan-messages/:loanId
exports.postLoanMessage = async (req, res) => {
  const { loanId } = req.params;
  const { content } = req.body;
  const userId = req.user?.userId;

  if (!content?.trim()) return res.status(400).json({ error: 'Content required' });

  try {
    const loan = await prisma.loan.findUnique({ where: { id: loanId }, select: { id: true }});
    if (!loan) return res.status(404).json({ error: 'Loan not found' });

    const msg = await prisma.loanMessage.create({
      data: { content: content.trim(), loanId, userId },        // ✅ userId
      include: { user: { select: { id: true, name: true } } },  // ✅ user
    });

    res.status(201).json(msg);
  } catch (e) {
    console.error('postLoanMessage error:', e);
    res.status(500).json({ error: 'Could not send message' });
  }
};
