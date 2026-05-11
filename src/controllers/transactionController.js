// src/controllers/transactionController.js
const prisma = require('../utils/prisma');
const { getUserId } = require('../middleware/authMiddleware');

exports.getMyTransactions = async (req, res) => {
  try {
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const currentUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true },
    });

    if (!currentUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    const isAdmin = currentUser.role === 'ADMIN';

    const transactions = await prisma.transaction.findMany({
      where: isAdmin
        ? {}
        : {
            OR: [{ fromUserId: userId }, { toUserId: userId }],
          },
      include: {
        fromUser: { select: { id: true, name: true, email: true } },
        toUser: { select: { id: true, name: true, email: true } },
      },
      orderBy: { timestamp: 'desc' },
    });

    console.log(
      `🔎 getMyTransactions: user=${userId} admin=${isAdmin} -> ${transactions.length} rows`
    );

    return res.json(transactions);
  } catch (err) {
    console.error('getMyTransactions error:', err);
    return res.status(500).json({ error: 'Failed to fetch transactions' });
  }
};