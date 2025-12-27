// src/routes/walletRoutes.js
const express = require('express');
const router = express.Router();

const { authenticateToken } = require('../middleware/authMiddleware');
const walletController = require('../controllers/walletController');

// Wallet balance / ledger
router.get('/me', authenticateToken, walletController.getMyWallet);

// NEW: deposit using saved funding card
router.post('/deposit', authenticateToken, walletController.depositFromFundingCard);

// 🔹 NEW: withdraw from wallet
router.post(
  '/withdraw',
  authenticateToken,
  walletController.withdrawFunds
);

// Dev helper (if you still use it)
router.post(
  '/dev-confirm-deposit',
  authenticateToken,
  walletController.devConfirmDeposit
);

// Stripe webhook (raw body)
router.post(
  '/webhook/stripe',
  express.raw({ type: 'application/json' }),
  walletController.stripeWebhook
);

module.exports = router;
