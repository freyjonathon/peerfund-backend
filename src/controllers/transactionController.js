// src/controllers/transactionController.js
const prisma = require('../utils/prisma');
const { getUserId } = require('../middleware/authMiddleware');

/**
 * GET /api/transactions
 * User view: returns the logged-in user's wallet ledger + transaction rows.
 */
exports.getMyTransactions = async (req, res) => {
  try {
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const limit = Math.min(parseInt(req.query.limit || '300', 10), 1000);

    const [transactions, ledgerRows] = await Promise.all([
      prisma.transaction.findMany({
        where: {
          OR: [{ fromUserId: userId }, { toUserId: userId }],
        },
        take: limit,
        include: {
          fromUser: { select: { id: true, name: true, email: true } },
          toUser: { select: { id: true, name: true, email: true } },
        },
        orderBy: { timestamp: 'desc' },
      }),

      prisma.walletLedger.findMany({
        where: {
          wallet: { userId },
        },
        take: limit,
        include: {
          wallet: {
            include: {
              user: { select: { id: true, name: true, email: true, role: true } },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    const normalizedTransactions = transactions.map((tx) => ({
      id: tx.id,
      source: 'Transaction',
      type: tx.type,
      amount: tx.amount,
      amountCents: Math.round(Number(tx.amount || 0) * 100),
      direction: null,
      timestamp: tx.timestamp || tx.processedAt || null,
      createdAt: tx.timestamp || tx.processedAt || null,
      loanId: tx.loanId || null,
      repaymentId: tx.repaymentId || null,
      fromUserId: tx.fromUserId || null,
      toUserId: tx.toUserId || null,
      fromUser: tx.fromUser || null,
      toUser: tx.toUser || null,
      peerfundFee: tx.peerfundFee || 0,
      bankingFee: tx.bankingFee || 0,
      metadata: null,
    }));

    const normalizedLedger = ledgerRows.map((row) => {
      const user = row.wallet?.user || null;

      return {
        id: row.id,
        source: 'WalletLedger',
        type: row.type,
        amount: row.amountCents / 100,
        amountCents: row.amountCents,
        direction: row.direction,
        timestamp: row.createdAt,
        createdAt: row.createdAt,
        balanceAfterCents: row.balanceAfterCents,
        referenceType: row.referenceType || null,
        referenceId: row.referenceId || null,
        loanId:
          row.referenceType === 'Loan'
            ? row.referenceId
            : row.metadata?.loanId || null,
        repaymentId: row.metadata?.repaymentId || null,
        walletId: row.walletId,
        userId: user?.id || null,
        user,
        fromUser: row.direction === 'DEBIT' ? user : null,
        toUser: row.direction === 'CREDIT' ? user : null,
        metadata: row.metadata || null,
      };
    });

    const combined = [...normalizedTransactions, ...normalizedLedger]
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
      .slice(0, limit);

    console.log(
      `🔎 getMyTransactions: user=${userId} tx=${transactions.length} ledger=${ledgerRows.length} combined=${combined.length}`
    );

    return res.json({
      isAdmin: false,
      count: combined.length,
      transactionCount: transactions.length,
      walletLedgerCount: ledgerRows.length,
      transactions: combined,
    });
  } catch (err) {
    console.error('getMyTransactions error:', err);
    return res.status(500).json({ error: 'Failed to fetch transactions' });
  }
};