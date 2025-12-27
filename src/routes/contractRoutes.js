const express = require('express');
const router = express.Router();
const controller = require('../controllers/contractController'); // <— no destructure yet
const authenticate = require('../middleware/authMiddleware');

console.log('🪵 full contractController object:', controller); // 👈 log the entire object
console.log('🪵 type of controller.createContract:', typeof controller.createContract); // 👈 log function check

router.post('/create', authenticate.authenticateToken, controller.createContract); // ✅ RIGHT


module.exports = router;
