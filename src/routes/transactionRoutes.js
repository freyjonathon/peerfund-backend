// src/routes/transactionRoutes.js
const express = require('express');
const router = express.Router();

const { authMiddleware, authenticateToken } = require('../middleware/authMiddleware');
const transactionController = require('../controllers/transactionController');

// Protect this route with the same auth you use elsewhere (e.g. wallet routes)
router.get('/', authenticateToken, transactionController.getMyTransactions);

module.exports = router;
