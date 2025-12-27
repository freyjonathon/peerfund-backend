// src/routes/paymentMethodRoutes.js
const express = require('express');
const router = express.Router();

const { authenticateToken } = require('../middleware/authMiddleware');
const pmCtl = require('../controllers/paymentMethodController');

// List my saved payment methods (default + loan bank flags)
router.get('/mine', authenticateToken, pmCtl.getMyPaymentMethods);

// Save a new Stripe us_bank_account PaymentMethod to my profile
// Body: { paymentMethodId, makeDefault?: boolean, useForLoans?: boolean }
router.post('/save', authenticateToken, pmCtl.savePaymentMethod);

// Set which saved PM is my default for deposits/repayments
// Body: { id }  // PaymentMethod.id
router.post('/set-default', authenticateToken, pmCtl.setDefaultPaymentMethod);

// Set which saved PM is used to receive loan payouts (isForLoans=true)
// Body: { id }  // PaymentMethod.id
router.post('/set-loan-bank', authenticateToken, pmCtl.setLoanReceivingBank);

module.exports = router;
