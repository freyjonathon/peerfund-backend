const router = require('express').Router();
const multer = require('multer');
const upload = multer(); // memory storage
const auth = require('../middleware/authMiddleware');
const ctrl = require('../controllers/verificationController');

// user routes
router.get('/verification/status', auth.authenticateToken, ctrl.getStatus);

// New photo uploads
router.post(
  '/verification/id/front',
  auth.authenticateToken,
  upload.single('file'),
  ctrl.uploadIdFront
);

router.post(
  '/verification/id/back',
  auth.authenticateToken,
  upload.single('file'),
  ctrl.uploadIdBack
);

router.post(
  '/verification/selfie',
  auth.authenticateToken,
  upload.single('file'),
  ctrl.uploadSelfie
);

// Optional: keep paystub endpoint
router.post(
  '/verification/paystub',
  auth.authenticateToken,
  upload.single('file'),
  ctrl.uploadPaystub
);

// admin routes
router.get(
  '/admin/verification/pending',
  auth.authenticateToken,
  ctrl.adminListPending
);

router.get(
  '/admin/verification/:userId/detail',
  auth.authenticateToken,
  ctrl.adminGetDetail
);

router.post(
  '/admin/verification/:userId/approve',
  auth.authenticateToken,
  ctrl.adminApprove
);

router.post(
  '/admin/verification/:userId/reject',
  auth.authenticateToken,
  ctrl.adminReject
);

module.exports = router;
