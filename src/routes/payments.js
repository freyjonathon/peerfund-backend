const express = require('express');
const router = express.Router();
const payments = require('../controllers/paymentsController');
const { authenticateToken } = require('../middleware/authMiddleware');

router.get('/has-default-payment-method', authenticateToken, payments.hasDefaultPaymentMethod);
router.post('/create-setup-intent', authenticateToken, payments.createSetupIntent);
router.post('/pay', authenticateToken, payments.pay);

// NEW fallback saver
router.post('/save-default-from-stripe', authenticateToken, payments.saveDefaultFromStripe);

module.exports = router;
