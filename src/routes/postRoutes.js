const express = require('express');
const router = express.Router();
const authenticate = require('../middleware/authMiddleware');
const postController = require('../controllers/postController');

// Get all posts (live feed)
router.get('/', authenticate.authenticateToken, postController.getAllPosts);

// Create a new post
router.post('/', authenticate.authenticateToken, postController.createPost);

module.exports = router;
