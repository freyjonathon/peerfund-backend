const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/authMiddleware');
const ctrl = require('../controllers/notificationController');

router.get('/notifications/unread-count', authenticateToken, ctrl.getUnreadCount);
router.get('/notifications', authenticateToken, ctrl.listNotifications);
router.post('/notifications/mark-all-read', authenticateToken, ctrl.markAllRead);
router.post('/notifications/:id/mark-read', authenticateToken, ctrl.markRead);

module.exports = router;
