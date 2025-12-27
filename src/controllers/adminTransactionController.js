// src/controllers/adminTransactionController.js
const prisma = require('../utils/prisma');

/**
 * GET /api/admin/transactions
 * Admin-only: returns most recent transactions across all users.
 *
 * Optional query params:
 *   - limit=100
 *   - userId=<id> (filters to a specific user as sender or receiver)
 *   - type=<TRANSACTION_TYPE>
 */
exports.getAllTransactions = async (req, res) => {
  try {
    if (req.user?.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const limit = Math.min(parseInt(req.query.limit || '200', 10), 500);
    const { userId, type } = req.query;

    const where = {};
    if (type) where.type = type;

    if (userId) {
      where.OR = [{ fromUserId: userId }, { toUserId: userId }];
    }

    // Use timestamp if you have it; otherwise fall back to createdAt
    // (If timestamp doesn't exist in your schema, Prisma will throw — switch to createdAt)
    let orderBy = { timestamp: 'desc' };
    // If your model uses createdAt instead of timestamp, uncomment:
    // let orderBy = { createdAt: 'desc' };

    const transactions = await prisma.transaction.findMany({
      where,
      take: limit,
      include: {
        fromUser: { select: { id: true, name: true, email: true } },
        toUser: { select: { id: true, name: true, email: true } },
        // ✅ IMPORTANT: DO NOT include `loan` unless your Prisma schema has a relation field named `loan`
        // If you only store `loanId`, you can just display that raw field on the frontend.
      },
      orderBy,
    });

    return res.json(transactions);
  } catch (err) {
    console.error('admin.getAllTransactions error:', err);
    return res.status(500).json({ error: 'Failed to load transactions' });
  }
};
