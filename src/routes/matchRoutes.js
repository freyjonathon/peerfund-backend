const express = require('express');
const router = express.Router();
const { getMatchingLoans } = require('../controllers/matchController');

router.get('/', getMatchingLoans);

module.exports = router;
