// src/routes/paymentMethodRoutes.js
const express = require('express');
const router = express.Router();

const authMw = require('../middleware/authMiddleware');
const requireAuth = authMw.authenticateToken || authMw; // support either export style

const pmCtl = require('../controllers/paymentMethodController');

// Helper: pick a controller fn if present, otherwise return a 501 stub
const ifFn = (fnName) =>
  typeof pmCtl[fnName] === 'function'
    ? pmCtl[fnName]
    : (req, res) =>
        res.status(501).json({ error: `Controller method '${fnName}' not implemented` });

// ---- Handlers with backward-compatible fallbacks ----

// List mine: prefer getMyPaymentMethods, fallback to your existing getPaymentMethod
const listMine = typeof pmCtl.getMyPaymentMethods === 'function'
  ? pmCtl.getMyPaymentMethods
  : pmCtl.getPaymentMethod;

// Save/attach: prefer attachAndSavePaymentMethod, fallback to your existing savePaymentMethod
const attachAndSave = typeof pmCtl.attachAndSavePaymentMethod === 'function'
  ? pmCtl.attachAndSavePaymentMethod
  : pmCtl.savePaymentMethod;

// Explicit save alias (kept for compatibility)
const saveMethod = typeof pmCtl.savePaymentMethod === 'function'
  ? pmCtl.savePaymentMethod
  : ifFn('savePaymentMethod');

// Other optional controllers (return 501 until you implement them)
const setDefault          = ifFn('setDefaultPaymentMethod');
const setLoanBank         = ifFn('setLoanReceivingBank');
const archiveMethod       = ifFn('archivePaymentMethod');
const getPublicLoanBank   = ifFn('getPublicReceivingBankMasked');

// ------------------ Routes ------------------

// Modern endpoints
router.get('/mine', requireAuth, listMine);
router.post('/attach-and-save', requireAuth, attachAndSave);
router.post('/save', requireAuth, saveMethod);
router.post('/set-default', requireAuth, setDefault);
router.post('/set-loan-bank', requireAuth, setLoanBank);
router.delete('/:id', requireAuth, archiveMethod);
router.get('/public-receive/:userId', getPublicLoanBank);

// Legacy compatibility (what you had before)
router.get('/', requireAuth, listMine);
router.post('/', requireAuth, saveMethod);

module.exports = router;
