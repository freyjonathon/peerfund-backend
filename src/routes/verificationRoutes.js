// routes/verificationRoutes.js
const router = require('express').Router();
const multer = require('multer');
const upload = multer(); // memory storage
const auth = require('../middleware/authMiddleware');
const ctrl = require('../controllers/verificationController');

// =======================
// USER ROUTES
// =======================

// GET /api/verification/status
router.get('/verification/status', auth.authenticateToken, ctrl.getStatus);

// POST /api/verification/id/front
router.post('/verification/id/front', auth.authenticateToken, upload.single('file'), ctrl.uploadIdFront);

// POST /api/verification/id/back
router.post('/verification/id/back', auth.authenticateToken, upload.single('file'), ctrl.uploadIdBack);

// POST /api/verification/selfie
router.post('/verification/selfie', auth.authenticateToken, upload.single('file'), ctrl.uploadSelfie);

// OPTIONAL: POST /api/verification/paystub
router.post('/verification/paystub', auth.authenticateToken, upload.single('file'), ctrl.uploadPaystub);

// =======================
// ADMIN ROUTES
// =======================

// GET /api/admin/verification/pending
router.get('/admin/verification/pending', auth.authenticateToken, ctrl.adminListPending);

// GET /api/admin/verification/:userId/detail
router.get('/admin/verification/:userId/detail', auth.authenticateToken, ctrl.adminGetDetail);

// POST /api/admin/verification/:userId/approve
router.post('/admin/verification/:userId/approve', auth.authenticateToken, ctrl.adminApprove);

// POST /api/admin/verification/:userId/reject
router.post('/admin/verification/:userId/reject', auth.authenticateToken, ctrl.adminReject);

module.exports = router;
