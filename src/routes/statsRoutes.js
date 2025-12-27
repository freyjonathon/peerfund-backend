// src/routes/statsRoutes.js
const express = require('express');
const router = express.Router();
const statsController = require('../controllers/statsController');
const authenticate = require('../middleware/authMiddleware');

// Protected route to get top lenders (optional: remove `authenticate` if public)
router.get('/top-lenders', authenticate.authenticateToken, statsController.getTopLenders);

module.exports = router;
