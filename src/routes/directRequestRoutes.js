// src/routes/directRequestRoutes.js
const express = require('express');
const { authenticateToken } = require('../middleware/authMiddleware');
const c = require('../controllers/directRequestController');

const router = express.Router();

// Borrower creates direct request
router.post('/', authenticateToken, c.createDirectRequest);

// Negotiation
router.post('/:id/counter', authenticateToken, c.counterDirectRequest);

// Lender actions
router.post('/:id/approve', authenticateToken, c.approveDirectRequest);
router.post('/:id/decline', authenticateToken, c.declineDirectRequest);

// Views / listings
router.get('/open/mine', authenticateToken, c.listOpenForUser);
router.get('/mine', authenticateToken, c.listMyDirectRequests);
router.get('/', authenticateToken, c.getMyDirectRequests);
router.get('/:id', authenticateToken, c.getDirectRequestById);

module.exports = router;
