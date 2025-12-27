const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const repaymentController = require('../controllers/repaymentController');

router.post('/:loanId', auth.authenticateToken, repaymentController.makeRepayment);
router.patch('/:repaymentId', auth.authenticateToken, repaymentController.recordRepayment);
router.get('/:loanId', auth.authenticateToken, repaymentController.getLoanRepayments);
router.post('/loans/:loanId/pay-next', auth.authenticateToken, repaymentController.payNextRepayment);

module.exports = router;
