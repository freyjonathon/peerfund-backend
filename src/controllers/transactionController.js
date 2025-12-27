// src/controllers/transactionController.js
const prisma = require('../utils/prisma');
const { getUserId } = require('../middleware/authMiddleware');

exports.getMyTransactions = async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const transactions = await prisma.transaction.findMany({
      where: {
        OR: [
          { fromUserId: userId },
          { toUserId: userId },
        ],
      },
      include: {
        fromUser: { select: { id: true, name: true } },
        toUser:   { select: { id: true, name: true } },
      },
      orderBy: { timestamp: 'desc' }, // or createdAt if that’s your field
    });

    console.log(
      `🔎 getMyTransactions: user=${userId} -> ${transactions.length} rows`
    );

    return res.json(transactions);
  } catch (err) {
    console.error('getMyTransactions error:', err);
    return res.status(500).json({ error: 'Failed to fetch transactions' });
  }
};
