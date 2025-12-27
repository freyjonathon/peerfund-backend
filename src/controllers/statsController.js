// src/controllers/statsController.js
const prisma = require('../utils/prisma');

exports.getTopLenders = async (req, res) => {
  const sortBy = req.query.sort || 'amount'; // 'amount' or 'count'

  try {
    const lenders = await prisma.loan.groupBy({
      by: ['lenderId'],
      _count: {
        lenderId: true
      },
      _sum: {
        amount: true
      },
      orderBy:
        sortBy === 'count'
          ? { _count: { lenderId: 'desc' } }
          : { _sum: { amount: 'desc' } },
      take: 10
    });

    const userIds = lenders.map((l) => l.lenderId);
    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, name: true }
    });

    const result = lenders.map((l) => {
      const user = users.find((u) => u.id === l.lenderId);
      return {
        userId: l.lenderId,
        name: user?.name || 'Anonymous',
        totalLoans: l._count.lenderId,
        totalAmount: l._sum.amount || 0
      };
    });

    res.json(result);
  } catch (err) {
    console.error('Error fetching top lenders:', err);
    res.status(500).json({ error: 'Failed to fetch top lenders' });
  }
};
