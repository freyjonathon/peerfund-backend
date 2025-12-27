const express = require('express');
const router = express.Router();
const messageController = require('../controllers/messageController');
const authenticate = require('../middleware/authMiddleware');

router.post('/:loanRequestId', authenticate.authenticateToken, messageController.postMessage);

module.exports = router;
