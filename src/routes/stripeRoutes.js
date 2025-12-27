// src/routes/stripeRoutes.js
const express = require('express');
const router = express.Router();

const { authenticateToken } = require('../middleware/authMiddleware');
const connectCtl = require('../controllers/stripeConnectController');

// ─ Borrower = Stripe Customer (wallet / repayments) ─
router.post('/ensure-customer', authenticateToken, connectCtl.ensureCustomer);
router.post('/create-bank-setup-intent', authenticateToken, connectCtl.createBankSetupIntent);

// ─ Payouts = Connect Account ─
router.post('/ensure-connect-account', authenticateToken, connectCtl.ensureConnectAccount);
router.post('/connect-onboarding-link', authenticateToken, connectCtl.createOnboardingLink);
router.get('/connect-account', authenticateToken, connectCtl.getConnectAccountStatus);

// ─ Loan funding bank (ACH destination for payouts) ─
router.get('/has-loan-payment-method', authenticateToken, connectCtl.hasLoanPaymentMethod);
router.post('/save-loan-payment-method', authenticateToken, connectCtl.saveLoanPaymentMethod);

// 🔁 Stripe returns here (no auth required; controller will redirect)
router.get('/onboarding/return', connectCtl.handleOnboardingReturn);

module.exports = router;
