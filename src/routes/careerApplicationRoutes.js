const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const { authenticateToken } = require('../middleware/authMiddleware');
const careerController = require('../controllers/careerApplicationController');

const router = express.Router();

const uploadDir = path.join(process.cwd(), 'uploads', 'resumes');

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const safeOriginal = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}-${safeOriginal}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype !== 'application/pdf') {
      return cb(new Error('Only PDF resumes are allowed.'));
    }
    cb(null, true);
  },
});

router.post('/careers/apply', upload.single('resume'), careerController.submitCareerApplication);

router.get('/careers/applications', authenticateToken, careerController.getCareerApplications);

router.get('/careers/resume/:applicationId', authenticateToken, careerController.downloadResume);

module.exports = router;