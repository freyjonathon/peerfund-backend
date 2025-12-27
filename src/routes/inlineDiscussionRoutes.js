const router = require('express').Router();
const auth = require('../middleware/authMiddleware');
const c = require('../controllers/inlineDiscussionController');

// Public read, authed write
router.get('/loans/:loanRequestId/_messages', c.getLoanRequestMessages);
router.post('/loans/:loanRequestId/_messages', auth.authenticateToken, c.postLoanRequestMessage);

module.exports = router;
