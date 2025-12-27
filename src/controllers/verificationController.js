// controllers/verificationController.js
const prisma = require('../utils/prisma');
const { getVerificationChecklist, REQUIRED_PAYSTUBS } = require('../utils/verification');

// GET /api/verification/status
exports.getStatus = async (req, res) => {
  try {
    const userId = req.user.userId;
    const checklist = await getVerificationChecklist(userId);
    return res.json(checklist);
  } catch (e) {
    console.error('verification.getStatus error', e);
    return res.status(500).json({ error: 'Could not get verification status' });
  }
};

/**
 * Helper to store a single verification image as a Document
 * kind: 'ID_FRONT' | 'ID_BACK' | 'SELFIE'
 */
async function saveVerificationImage({ userId, file, kind, title }) {
  if (!file) throw new Error('Missing file');

  await prisma.document.create({
    data: {
      userId,
      type: kind,
      title,
      fileName: file.originalname,
      mimeType: file.mimetype,
      content: file.buffer, // still store as Buffer
    },
  });

  // Flip user back to PENDING whenever docs change
  await prisma.user.update({
    where: { id: userId },
    data: { verificationStatus: 'PENDING' },
  });
}

// POST /api/verification/id/front  (multipart/form-data: file=...)
exports.uploadIdFront = async (req, res) => {
  try {
    const userId = req.user.userId;
    if (!req.file) return res.status(400).json({ error: 'Missing file' });

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
    return res.status(500).json({ error: 'Failed to upload front of ID' });
  }
};

// POST /api/verification/id/back  (multipart/form-data: file=...)
exports.uploadIdBack = async (req, res) => {
  try {
    const userId = req.user.userId;
    if (!req.file) return res.status(400).json({ error: 'Missing file' });

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
    return res.status(500).json({ error: 'Failed to upload back of ID' });
  }
};

// POST /api/verification/selfie  (multipart/form-data: file=...)
exports.uploadSelfie = async (req, res) => {
  try {
    const userId = req.user.userId;
    if (!req.file) return res.status(400).json({ error: 'Missing file' });

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
    return res.status(500).json({ error: 'Failed to upload selfie' });
  }
};

// OPTIONAL: keep paystub upload if you still want income docs
// POST /api/verification/paystub  (multipart/form-data: file=...)
exports.uploadPaystub = async (req, res) => {
  try {
    const userId = req.user.userId;
    if (!req.file) return res.status(400).json({ error: 'Missing file' });

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
    return res.status(500).json({ error: 'Failed to upload paystub' });
  }
};

// ADMIN: POST /api/admin/verification/:userId/approve
exports.adminApprove = async (req, res) => {
  try {
    const adminId = req.user.userId;

    // only admins can approve
    if (req.user.role !== 'ADMIN') {
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
    if (req.user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { userId } = req.params;

    // For now we just flip status to REJECTED.
    // (If you later add a verificationNotes field in schema,
    //  we can save a reason as well.)
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
    if (req.user.role !== 'ADMIN') {
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

    // 2) For each user, compute checklist (hasIdFront, hasIdBack, hasSelfie,...)
    const rows = await Promise.all(
      users.map(async (u) => {
        const checklist = await getVerificationChecklist(u.id);

        // You can decide what "submittedAt" means; here we take
        // the latest of any submission field, or fall back to user.createdAt.
        const submittedAt =
          checklist.submittedAt ||
          checklist.latestDocAt ||
          u.createdAt;

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
    return res
      .status(500)
      .json({ error: 'Failed to load pending verifications' });
  }
};

// GET /api/admin/verification/:userId/detail
exports.adminGetDetail = async (req, res) => {
  try {
    if (req.user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { userId } = req.params;

    // Only select fields that definitely exist on User in your schema
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        verificationStatus: true,
        createdAt: true,
        // ⚠️ leave these commented out unless you’ve added them to schema.prisma
        // verificationNotes: true,
        // verifiedAt: true,
        // verifiedById: true,
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
        // do NOT select `content` here; we’ll stream it from /api/documents/:id
      },
    });

    return res.json({ user, docs });
  } catch (e) {
    console.error('verification.adminGetDetail error', e);
    return res
      .status(500)
      .json({ error: 'Failed to load verification detail' });
  }
};
