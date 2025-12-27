const express = require('express');
const router = express.Router();
const webhookCtl = require('../controllers/stripeWebhookController');

// One route only; Stripe requires raw body for signature verification
router.post('/webhook', express.raw({ type: 'application/json' }), webhookCtl.handleStripeWebhook);

module.exports = router;
