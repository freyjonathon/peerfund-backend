const prisma = require('../utils/prisma');

// Helper you can call from anywhere in your app (offers, repayments, etc.)
async function createNotification({ userId, type, message, data = {} }) {
  const note = await prisma.notification.create({
    data: { userId, type, message, data }
  });
  // If using Socket.IO, emit to the user's room
  if (global.io) {
    io.to(`user:${userId}`).emit('notification:new', {
      id: note.id,
      type: note.type,
      message: note.message,
      data: note.data,
      createdAt: note.createdAt,
      isRead: note.isRead
    });
  }
  return note;
}

async function getUnreadCount(req, res) {
  const userId = req.user.userId;
  const count = await prisma.notification.count({
    where: { userId, isRead: false }
  });
  res.json({ count });
}

async function listNotifications(req, res) {
  const userId = req.user.userId;
  const onlyUnread = req.query.onlyUnread === 'true';
  const limit = Math.min(parseInt(req.query.limit || '15', 10), 50);
  const items = await prisma.notification.findMany({
    where: { userId, ...(onlyUnread ? { isRead: false } : {}) },
    orderBy: { createdAt: 'desc' },
    take: limit
  });
  res.json(items);
}

async function markRead(req, res) {
  const userId = req.user.userId;
  const { id } = req.params;
  await prisma.notification.updateMany({
    where: { id, userId },
    data: { isRead: true, readAt: new Date() }
  });
  res.json({ ok: true });
}

async function markAllRead(req, res) {
  const userId = req.user.userId;
  await prisma.notification.updateMany({
    where: { userId, isRead: false },
    data: { isRead: true, readAt: new Date() }
  });
  res.json({ ok: true });
}

module.exports = {
  createNotification,
  getUnreadCount,
  listNotifications,
  markRead,
  markAllRead
};
