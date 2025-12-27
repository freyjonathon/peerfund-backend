const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');

// Match the exported function names
router.post('/register', authController.registerUser);
router.post('/login', authController.loginUser);

module.exports = router;
