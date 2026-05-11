// src/controllers/adminTransactionController.js
const prisma = require('../utils/prisma');

/**
 * GET /api/admin/transactions
 * Admin-only: returns platform-wide transactions + wallet ledger activity.
 */
exports.getAllTransactions = async (req, res) => {
  try {
    if (req.user?.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const limit = Math.min(parseInt(req.query.limit || '300', 10), 1000);
    const { userId, type } = req.query;

    const txWhere = {};
    if (type) txWhere.type = type;

    if (userId) {
      txWhere.OR = [{ fromUserId: userId }, { toUserId: userId }];
    }

    const ledgerWhere = {};
    if (type) ledgerWhere.type = type;

    if (userId) {
      ledgerWhere.wallet = { userId };
    }

    const [transactions, ledgerRows] = await Promise.all([
      prisma.transaction.findMany({
        where: txWhere,
        take: limit,
        include: {
          fromUser: { select: { id: true, name: true, email: true, role: true } },
          toUser: { select: { id: true, name: true, email: true, role: true } },
        },
        orderBy: { timestamp: 'desc' },
      }),

      prisma.walletLedger.findMany({
        where: ledgerWhere,
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

    return res.json({
      isAdmin: true,
      count: combined.length,
      transactionCount: transactions.length,
      walletLedgerCount: ledgerRows.length,
      transactions: combined,
    });
  } catch (err) {
    console.error('admin.getAllTransactions error:', err);
    return res.status(500).json({ error: 'Failed to load transactions' });
  }
};