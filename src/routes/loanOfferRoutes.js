const express = require('express');
const router = express.Router();
const loanOfferController = require('../controllers/loanOfferController');
const authenticate = require('../middleware/authMiddleware');

// POST /api/loans/:loanId/offers
router.post('/:loanId/offers', authenticate, loanOfferController.createLoanOffer);

// GET /api/loans/:loanId/offers
router.get('/:loanId/offers', authenticate, loanOfferController.getLoanOffers);

// routes/loanRequestRoutes.js
router.get('/open', authMiddleware, getOpenLoanRequests);

module.exports = router;
