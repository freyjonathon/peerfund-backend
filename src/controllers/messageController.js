const prisma = require('../utils/prisma');


// POST /api/messages/:loanRequestId
exports.postMessage = async (req, res) => {
  const { content } = req.body;
  const senderId = req.user.userId;
  const loanRequestId = req.params.loanRequestId;

  if (!content || !loanRequestId) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const message = await prisma.message.create({
      data: {
        content,
        senderId,
        loanRequestId
      }
    });

    res.status(201).json(message);
  } catch (err) {
    console.error('Failed to post message:', err);
    res.status(500).json({ error: 'Failed to send message' });
  }
};
