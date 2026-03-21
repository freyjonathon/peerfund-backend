// controllers/verificationController.js
const prisma = require('../utils/prisma');
const { getVerificationChecklist, REQUIRED_PAYSTUBS } = require('../utils/verification');

/* -------------------------------------------------------------------------- */
/* Upload validation                                                          */
/* -------------------------------------------------------------------------- */
const MAX_BYTES = 25 * 1024 * 1024; // 25MB

function getAuthUserId(req) {
  return req.user?.userId || req.user?.id || null;
}

function assertValidUpload(file, { allowPaystub = false } = {}) {
  if (!file) {
    const err = new Error('Missing file');
    err.status = 400;
    throw err;
  }

  // Paystubs might be PDFs/images; everything else must be an image.
  if (allowPaystub) {
    const ok =
      (file.mimetype && file.mimetype.startsWith('image/')) ||
      file.mimetype === 'application/pdf';
    if (!ok) {
      const err = new Error('Paystub must be an image or PDF.');
      err.status = 400;
      throw err;
    }
  } else {
    if (!file.mimetype || !file.mimetype.startsWith('image/')) {
      const err = new Error('Only image uploads are allowed.');
      err.status = 400;
      throw err;
    }
  }

  // multer limits may set this; still validate here for safety.
  if (typeof file.size === 'number' && file.size > MAX_BYTES) {
    const err = new Error('File too large. Please upload an image under 6MB.');
    err.status = 413;
    throw err;
  }
}

/**
 * Helper to store a single verification image as a Document
 * kind: 'ID_FRONT' | 'ID_BACK' | 'SELFIE'
 */
async function saveVerificationImage({ userId, file, kind, title }) {
  if (!userId) {
    const err = new Error('Unauthorized');
    err.status = 401;
    throw err;
  }

  await prisma.document.create({
    data: {
      userId,
      type: kind,
      title,
      fileName: file.originalname,
      mimeType: file.mimetype,
      content: file.buffer, // stores as Buffer in Mongo
    },
  });

  // Flip user back to PENDING whenever docs change
  await prisma.user.update({
    where: { id: userId },
    data: { verificationStatus: 'PENDING' },
  });
}

/* -------------------------------------------------------------------------- */
/* USER ROUTES                                                                */
/* -------------------------------------------------------------------------- */

// GET /api/verification/status
exports.getStatus = async (req, res) => {
  try {
    const userId = getAuthUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const checklist = await getVerificationChecklist(userId);
    return res.json(checklist);
  } catch (e) {
    console.error('verification.getStatus error', e);
    return res.status(500).json({ error: 'Could not get verification status' });
  }
};

// POST /api/verification/id/front  (multipart/form-data: file=...)
exports.uploadIdFront = async (req, res) => {
  try {
    const userId = getAuthUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    assertValidUpload(req.file);

    await saveVerificationImage({
      userId,
      file: req.file,
      kind: 'ID_FRONT',
      title: 'ID Front',
    });

    const checklist = await getVerificationChecklist(userId);
    return res.status(201).json({ message: 'Front of ID uploaded', checklist });
  } catch (e) {
    console.error('verification.uploadIdFront error', e);
    return res.status(e.status || 500).json({ error: e.message || 'Failed to upload front of ID' });
  }
};

// POST /api/verification/id/back  (multipart/form-data: file=...)
exports.uploadIdBack = async (req, res) => {
  try {
    const userId = getAuthUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    assertValidUpload(req.file);

    await saveVerificationImage({
      userId,
      file: req.file,
      kind: 'ID_BACK',
      title: 'ID Back',
    });

    const checklist = await getVerificationChecklist(userId);
    return res.status(201).json({ message: 'Back of ID uploaded', checklist });
  } catch (e) {
    console.error('verification.uploadIdBack error', e);
    return res.status(e.status || 500).json({ error: e.message || 'Failed to upload back of ID' });
  }
};

// POST /api/verification/selfie  (multipart/form-data: file=...)
exports.uploadSelfie = async (req, res) => {
  try {
    const userId = getAuthUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    assertValidUpload(req.file);

    await saveVerificationImage({
      userId,
      file: req.file,
      kind: 'SELFIE',
      title: 'Selfie',
    });

    const checklist = await getVerificationChecklist(userId);
    return res.status(201).json({ message: 'Selfie uploaded', checklist });
  } catch (e) {
    console.error('verification.uploadSelfie error', e);
    return res.status(e.status || 500).json({ error: e.message || 'Failed to upload selfie' });
  }
};

// OPTIONAL: keep paystub upload if you still want income docs
// POST /api/verification/paystub  (multipart/form-data: file=...)
exports.uploadPaystub = async (req, res) => {
  try {
    const userId = getAuthUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    assertValidUpload(req.file, { allowPaystub: true });

    await prisma.document.create({
      data: {
        userId,
        type: 'PAYSTUB',
        title: 'Paystub',
        fileName: req.file.originalname,
        mimeType: req.file.mimetype,
        content: req.file.buffer,
      },
    });

    // Limit to most recent REQUIRED_PAYSTUBS (if you still care)
    const stubs = await prisma.document.findMany({
      where: { userId, type: 'PAYSTUB' },
      orderBy: { createdAt: 'desc' },
    });

    if (REQUIRED_PAYSTUBS && stubs.length > REQUIRED_PAYSTUBS) {
      const toDelete = stubs.slice(REQUIRED_PAYSTUBS);
      await prisma.document.deleteMany({
        where: { id: { in: toDelete.map((s) => s.id) } },
      });
    }

    await prisma.user.update({
      where: { id: userId },
      data: { verificationStatus: 'PENDING' },
    });

    const checklist = await getVerificationChecklist(userId);
    return res.status(201).json({ message: 'Paystub uploaded', checklist });
  } catch (e) {
    console.error('verification.uploadPaystub error', e);
    return res.status(e.status || 500).json({ error: e.message || 'Failed to upload paystub' });
  }
};

/* -------------------------------------------------------------------------- */
/* ADMIN ROUTES                                                               */
/* -------------------------------------------------------------------------- */

// ADMIN: POST /api/admin/verification/:userId/approve
exports.adminApprove = async (req, res) => {
  try {
    const adminId = getAuthUserId(req);

    // only admins can approve
    if (req.user?.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { userId } = req.params;
    const checklist = await getVerificationChecklist(userId);

    // Require ID_FRONT + ID_BACK + SELFIE
    if (!(checklist.hasIdFront && checklist.hasIdBack && checklist.hasSelfie)) {
      return res
        .status(400)
        .json({ error: 'User has not submitted all required verification photos' });
    }

    // Minimal update: just mark as APPROVED
    await prisma.user.update({
      where: { id: userId },
      data: {
        verificationStatus: 'APPROVED',
      },
    });

    return res.json({ message: 'User approved', byAdmin: adminId });
  } catch (e) {
    console.error('verification.adminApprove error', e);
    return res.status(500).json({ error: 'Failed to approve user' });
  }
};

// ADMIN: POST /api/admin/verification/:userId/reject
exports.adminReject = async (req, res) => {
  try {
    if (req.user?.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { userId } = req.params;

    await prisma.user.update({
      where: { id: userId },
      data: {
        verificationStatus: 'REJECTED',
      },
    });

    return res.json({ message: 'User rejected' });
  } catch (e) {
    console.error('verification.adminReject error', e);
    return res.status(500).json({ error: 'Failed to reject user' });
  }
};

/**
 * Admin helpers for dashboard: list pending and get full detail (user + docs)
 */

// GET /api/admin/verification/pending
exports.adminListPending = async (req, res) => {
  try {
    if (req.user?.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // 1) Find all users currently PENDING
    const users = await prisma.user.findMany({
      where: { verificationStatus: 'PENDING' },
      select: {
        id: true,
        name: true,
        email: true,
        createdAt: true,
        verificationStatus: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    // 2) For each user, compute checklist
    const rows = await Promise.all(
      users.map(async (u) => {
        const checklist = await getVerificationChecklist(u.id);

        const submittedAt = checklist.submittedAt || checklist.latestDocAt || u.createdAt;

        return {
          userId: u.id,
          id: u.id,
          name: u.name,
          email: u.email,
          createdAt: u.createdAt,
          submittedAt,
          verificationStatus: u.verificationStatus || checklist.status || 'PENDING',
          hasIdFront: !!checklist.hasIdFront,
          hasIdBack: !!checklist.hasIdBack,
          hasSelfie: !!checklist.hasSelfie,
        };
      })
    );

    return res.json(rows);
  } catch (e) {
    console.error('verification.adminListPending error', e);
    return res.status(500).json({ error: 'Failed to load pending verifications' });
  }
};

// GET /api/admin/verification/:userId/detail
exports.adminGetDetail = async (req, res) => {
  try {
    if (req.user?.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { userId } = req.params;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        verificationStatus: true,
        createdAt: true,
      },
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Fetch the three verification images
    const docs = await prisma.document.findMany({
      where: {
        userId,
        type: { in: ['ID_FRONT', 'ID_BACK', 'SELFIE'] },
      },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        type: true,
        title: true,
        mimeType: true,
        createdAt: true,
        // do NOT select `content` here
      },
    });

    return res.json({ user, docs });
  } catch (e) {
    console.error('verification.adminGetDetail error', e);
    return res.status(500).json({ error: 'Failed to load verification detail' });
  }
};

