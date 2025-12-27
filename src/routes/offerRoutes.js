const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Create an offer
router.post('/', async (req, res) => {
  const { lenderId, requestId, interest, duration, amount, message } = req.body;
  try {
    const offer = await prisma.offer.create({
      data: {
        lenderId: parseInt(lenderId),
        requestId: parseInt(requestId),
        interest,
        duration,
        amount,
        message,
      },
    });
    res.json(offer);
  } catch (err) {
    console.error('Error creating offer:', err);
    res.status(500).json({ error: 'Failed to create offer' });
  }
});

module.exports = router;
