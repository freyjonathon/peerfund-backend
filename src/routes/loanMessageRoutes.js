// routes/loanMessageRoutes.js
const express = require('express');
const router = express.Router();
const loanMessageController = require('../controllers/loanMessageController');
const authenticate = require('../middleware/authMiddleware');

// Public read
router.get('/loans/:loanId/messages', authenticate.authenticateToken, loanMessageController.getLoanMessages);

// Auth-only write
router.post('/loans/:loanId/messages', authenticate.authenticateToken, loanMessageController.postLoanMessage);

module.exports = router;
