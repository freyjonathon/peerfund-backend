// src/routes/documents.js
const express = require('express');
const router = express.Router();

const authenticate = require('../middleware/authMiddleware');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

const {
  saveContract,
  uploadDocument,
  getMyDocuments,
  getDocumentById,
} = require('../controllers/documentController');

// list docs (metadata)
router.get('/', authenticate.authenticateToken, getMyDocuments);

// view single doc (includes base64 for preview)
router.get('/:documentId', authenticate.authenticateToken, getDocumentById);

// existing routes
router.post('/contract', authenticate.authenticateToken, saveContract);
router.post('/upload', authenticate.authenticateToken, upload.single('file'), uploadDocument);

module.exports = router;
