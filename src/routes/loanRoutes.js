// src/routes/loanRoutes.js
const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/authMiddleware');

const loanRequestController = require('../controllers/loanRequestController');
const loanOfferController = require('../controllers/loanOfferController');
const repaymentController = require('../controllers/repaymentController');
const loanMessageController = require('../controllers/loanMessageController');

// ⛔ We no longer need loanFundingController for /:loanId/fund
// const loanFunding = require('../controllers/loanFundingController');

// ---------------------------------------------------------------------
// Loan Requests (market)
// ---------------------------------------------------------------------
router.get('/open', authenticateToken, loanRequestController.getOpenLoanRequests);
router.post('/', authenticateToken, loanRequestController.createLoanRequest);
router.get('/:loanId', authenticateToken, loanRequestController.getLoanDetails);

// ---------------------------------------------------------------------
// Loan Offers
// ---------------------------------------------------------------------
router.get('/:loanId/offers', authenticateToken, loanOfferController.getLoanOffers);
router.post('/:loanId/offers', authenticateToken, loanOfferController.submitLoanOffer);

// Borrower accepts an offer -> creates Loan (status: ACCEPTED)
router.post(
  '/offers/:offerId/accept',
  authenticateToken,
  loanOfferController.acceptLoanOffer
);

// Fast endpoint: loan requests where *I* have made an offer (for dashboard)
router.get(
  '/offers/mine',
  authenticateToken,
  loanOfferController.getMyOfferRequests
);

// ---------------------------------------------------------------------
// Repayments
// ---------------------------------------------------------------------
router.get(
  '/:loanId/repayments',
  authenticateToken,
  repaymentController.getLoanRepayments
);

router.post(
  '/:loanId/pay-next',
  authenticateToken,
  repaymentController.payNextRepayment
);

// ---------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------
router.get(
  '/:loanId/messages',
  authenticateToken,
  loanMessageController.getLoanMessages
);
router.post(
  '/:loanId/messages',
  authenticateToken,
  loanMessageController.postLoanMessage
);

// ---------------------------------------------------------------------
// Funding – wallet-only flow
// POST /api/loans/:loanId/fund
//   => debits lender's wallet.availableCents
//      credits borrower's wallet.availableCents
//      creates DISBURSEMENT transaction
//      marks loan FUNDED
// ---------------------------------------------------------------------
router.post(
  '/:loanId/fund',
  authenticateToken,
  loanOfferController.fundLoanByLender
);

module.exports = router;

