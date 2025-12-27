// src/controllers/documentController.js
const prisma = require('../utils/prisma');

/**
 * GET /api/documents
 * List user's docs (metadata only; no binary)
 */
exports.getMyDocuments = async (req, res) => {
  const userId = req.user.userId;

  try {
    const documents = await prisma.document.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        userId: true,
        loanId: true,
        title: true,
        type: true,
        fileName: true,
        mimeType: true,
        createdAt: true,
      },
    });

    res.json(documents);
  } catch (err) {
    console.error('Error fetching documents:', err);
    res.status(500).json({ error: 'Could not retrieve documents.' });
  }
};

/**
 * GET /api/documents/:documentId
 * Returns metadata + base64 for preview.
 * Access: owner OR ADMIN
 */
exports.getDocumentById = async (req, res) => {
  try {
    const requesterId = req.user.userId;
    const requesterRole = req.user.role; // should be set by auth middleware
    const { documentId } = req.params;

    const doc = await prisma.document.findUnique({
      where: { id: documentId },
      select: {
        id: true,
        userId: true,
        loanId: true,
        title: true,
        type: true,
        fileName: true,
        mimeType: true,
        createdAt: true,
        content: true, // IMPORTANT (Buffer for uploads)
      },
    });

    if (!doc) return res.status(404).json({ error: 'Document not found' });

    // Access check: owner OR admin
    const isOwner = doc.userId === requesterId;
    const isAdmin = requesterRole === 'ADMIN';
    if (!isOwner && !isAdmin) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // If content is a Buffer, return base64 for preview
    let base64 = null;

    if (doc.content) {
      // Prisma Bytes usually comes back as Buffer in Node
      if (Buffer.isBuffer(doc.content)) {
        base64 = doc.content.toString('base64');
      } else if (typeof doc.content === 'string') {
        // If you saved contracts as string content, you can return as base64 text/plain
        base64 = Buffer.from(doc.content, 'utf8').toString('base64');
        // If mimeType is missing for text docs, set a reasonable default
        if (!doc.mimeType) doc.mimeType = 'text/plain';
      }
    }

    // Don’t return raw content directly
    return res.json({
      id: doc.id,
      userId: doc.userId,
      loanId: doc.loanId,
      title: doc.title,
      type: doc.type,
      fileName: doc.fileName,
      mimeType: doc.mimeType,
      createdAt: doc.createdAt,
      base64, // THIS is what your viewer needs
    });
  } catch (err) {
    console.error('getDocumentById error:', err);
    return res.status(500).json({ error: 'Failed to load document' });
  }
};

exports.saveContract = async (req, res) => {
  const userId = req.user.userId;
  const { loanId, content, title = 'Loan Agreement', type = 'contract' } = req.body;

  try {
    const document = await prisma.document.create({
      data: {
        userId,
        loanId,
        title,
        type,
        content, // likely string
      },
    });

    res.status(201).json(document);
  } catch (err) {
    console.error('Error saving contract document:', err);
    res.status(500).json({ error: 'Could not save document' });
  }
};

exports.uploadDocument = async (req, res) => {
  const userId = req.user.userId;
  const { title, type } = req.body;
  const file = req.file;

  if (!file || !title || !type) {
    return res.status(400).json({ error: 'Missing required fields or file.' });
  }

  try {
    const newDoc = await prisma.document.create({
      data: {
        userId,
        title,
        type,
        content: file.buffer, // Buffer
        mimeType: file.mimetype,
        fileName: file.originalname,
      },
    });

    res.status(201).json({ message: 'Document uploaded', document: newDoc });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Upload failed' });
  }
};
