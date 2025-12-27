// src/routes/adminTransactionRoutes.js
const router = require('express').Router();
const auth = require('../middleware/authMiddleware');
const ctrl = require('../controllers/adminTransactionController');

// GET /api/admin/transactions
router.get('/admin/transactions', auth.authenticateToken, ctrl.getAllTransactions);

module.exports = router;
