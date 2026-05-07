// src/routes/stripeRoutes.js
const express = require('express');
const router = express.Router();

const { authenticateToken } = require('../middleware/authMiddleware');
const connectCtl = require('../controllers/stripeConnectController');

// ─ Borrower = Stripe Customer (wallet / repayments) ─
router.post('/ensure-customer', authenticateToken, connectCtl.ensureCustomer);
router.post('/create-bank-setup-intent', authenticateToken, connectCtl.createBankSetupIntent);
router.post('/save-ach-payment-method', authenticateToken, connectCtl.saveAchPaymentMethod);

// ─ Payouts = Connect Account ─
router.post('/ensure-connect-account', authenticateToken, connectCtl.ensureConnectAccount);
router.post('/connect-onboarding-link', authenticateToken, connectCtl.createOnboardingLink);
router.get('/connect-account', authenticateToken, connectCtl.getConnectAccountStatus);

// ─ Loan funding bank (ACH destination for payouts) ─
router.get('/has-loan-payment-method', authenticateToken, connectCtl.hasLoanPaymentMethod);
router.post('/save-loan-payment-method', authenticateToken, connectCtl.saveLoanPaymentMethod);


router.get('/ach-payment-method', authenticateToken, connectCtl.getAchPaymentMethod);
router.get('/achPaymentMethod', authenticateToken, connectCtl.getAchPaymentMethod);

// ✅ Stripe redirects back to FRONTEND (not API) so this route is optional.
// If you keep it, it should NOT expect auth.
router.get('/onboarding/return', (_req, res) => {
  const FRONTEND_ORIGIN = (process.env.FRONTEND_ORIGIN || 'http://localhost:3000')
    .split(',')[0]
    .trim();
  return res.redirect(`${FRONTEND_ORIGIN}/payment-method?onboarding=return`);
});

module.exports = router;
