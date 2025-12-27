// src/routes/userRoutes.js
const express = require('express');
const router = express.Router();

const {
  getUserProfile,
  updateUserProfile,
  getUserName,
  addPhoneNumber,
  upgradeToSuperUser,          // <-- we'll wire this to Stripe subscription logic
  getPublicUserProfileById,
  getLendingTerms,
  updateLendingTerms,
  // upgradeSuperuserFromWallet // <- not needed for Option C, remove if unused
} = require('../controllers/userController');

const userLoanController = require('../controllers/userLoanController');
const documentController = require('../controllers/documentController');
const { authenticateToken } = require('../middleware/authMiddleware');

// -------- Money summary --------
router.get('/my-money-summary', authenticateToken, userLoanController.getMoneySummary);

// -------- Current user's profile --------
router.get('/profile', authenticateToken, getUserProfile);
router.put('/profile', authenticateToken, updateUserProfile);

// -------- Public profile-by-id (no auth) --------
router.get('/:id/profile', getPublicUserProfileById);

// -------- Documents / misc user endpoints --------
router.get('/documents/:documentId', authenticateToken, documentController.getMyDocuments);
router.get('/name', authenticateToken, getUserName);
router.patch('/add-phone', authenticateToken, addPhoneNumber);

// -------- SuperUser upgrade (Option C: Stripe subscription) --------
// This is what your Dashboard `handleUpgrade` calls: POST /api/users/superuser/upgrade
router.post('/superuser/upgrade', authenticateToken, upgradeToSuperUser);

// -------- Lending terms --------
router.get('/me/lending-terms', authenticateToken, getLendingTerms);
router.put('/me/lending-terms', authenticateToken, updateLendingTerms);

module.exports = router;
