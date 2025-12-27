const express = require('express');
const router = express.Router();
const authenticate = require('../middleware/authMiddleware');
const { requireAdmin } = require('../middleware/authMiddleware');
const adminController = require('../controllers/adminController');

// ...admin endpoints
router.use(authenticate.authenticateToken);
router.use(authenticate.requireAdmin);

// View all users
router.get('/users', authenticate.authenticateToken, requireAdmin, adminController.getAllUsers);

// Edit any user profile
router.put('/users/:id', authenticate.authenticateToken, requireAdmin, adminController.updateUser);

// Delete any user
router.delete('/users/:id', authenticate.authenticateToken, requireAdmin, adminController.deleteUser);

module.exports = router;
