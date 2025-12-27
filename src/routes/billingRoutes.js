// src/routes/billingRoutes.js
const express = require('express');
const router = express.Router();

const { authenticateToken } = require('../middleware/authMiddleware');
const billingController = require('../controllers/billingController');

router.post(
  '/card/setup-intent',
  authenticateToken,
  billingController.createCardSetupIntent
);

router.post(
  '/card/set-funding-method',
  authenticateToken,
  billingController.setFundingPaymentMethod
);

router.get(
  '/has-loan-payment-method',
  authenticateToken,
  billingController.hasLoanPaymentMethod
);

module.exports = router;
