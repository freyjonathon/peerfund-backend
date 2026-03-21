// routes/verificationRoutes.js
const router = require('express').Router();
const multer = require('multer');
const auth = require('../middleware/authMiddleware');
const ctrl = require('../controllers/verificationController');

// memory storage + size limits
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
  },
});

// =======================
// USER ROUTES
// =======================
router.get('/verification/status', auth.authenticateToken, ctrl.getStatus);

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

router.post(
  '/verification/paystub',
  auth.authenticateToken,
  upload.single('file'),
  ctrl.uploadPaystub
);

// =======================
// ADMIN ROUTES
// =======================
router.get('/admin/verification/pending', auth.authenticateToken, ctrl.adminListPending);
router.get('/admin/verification/:userId/detail', auth.authenticateToken, ctrl.adminGetDetail);
router.post('/admin/verification/:userId/approve', auth.authenticateToken, ctrl.adminApprove);
router.post('/admin/verification/:userId/reject', auth.authenticateToken, ctrl.adminReject);

module.exports = router;
