const prisma = require('../utils/prisma');

// GET /api/loans/:loanRequestId/_messages
exports.getLoanRequestMessages = async (req, res) => {
  const { loanRequestId } = req.params;
  try {
    const request = await prisma.loanRequest.findUnique({
      where: { id: loanRequestId },
      select: { id: true }
    });
    if (!request) return res.status(404).json({ error: 'Loan request not found' });

    const messages = await prisma.loanRequestMessage.findMany({
      where: { loanRequestId },
      include: {
        user: { select: { id: true, name: true } },   // ✅ user, not sender
      },
      orderBy: { createdAt: 'asc' },
    });

    res.json(messages);
  } catch (e) {
    console.error('getRequestMessages error:', e);
    res.status(500).json({ error: 'Could not fetch messages' });
  }
};

// POST /api/loans/:loanRequestId/_messages
exports.postLoanRequestMessage = async (req, res) => {
  const { loanRequestId } = req.params;
  const { content } = req.body;
  const userId = req.user?.userId;

  if (!content?.trim()) return res.status(400).json({ error: 'Content required' });

  try {
    const request = await prisma.loanRequest.findUnique({
      where: { id: loanRequestId },
      select: { id: true }
    });
    if (!request) return res.status(404).json({ error: 'Loan request not found' });

    const msg = await prisma.loanRequestMessage.create({
      data: { content: content.trim(), loanRequestId, userId },  // ✅ userId
      include: { user: { select: { id: true, name: true } } },   // ✅ user
    });

    res.status(201).json(msg);
  } catch (e) {
    console.error('postRequestMessage error:', e);
    res.status(500).json({ error: 'Could not send message' });
  }
};
