const path = require('path');
const prisma = require('../utils/prisma');

exports.submitCareerApplication = async (req, res) => {
  try {
    const { name, email, phone, linkedin, role, whyPeerFund } = req.body || {};

    if (!name || !email || !role) {
      return res.status(400).json({
        error: 'Name, email, and role are required.',
      });
    }

    if (!req.file) {
      return res.status(400).json({
        error: 'Resume PDF is required.',
      });
    }

    const application = await prisma.careerApplication.create({
      data: {
        name: String(name).trim(),
        email: String(email).trim(),
        phone: phone ? String(phone).trim() : null,
        linkedin: linkedin ? String(linkedin).trim() : null,
        role: String(role).trim(),
        whyPeerFund: whyPeerFund ? String(whyPeerFund).trim() : null,
        resumePath: req.file.path,
        resumeName: req.file.originalname,
      },
    });

    return res.status(201).json({
      ok: true,
      message: 'Application submitted successfully.',
      applicationId: application.id,
    });
  } catch (err) {
    console.error('submitCareerApplication error:', err);
    return res.status(500).json({
      error: 'Failed to submit application.',
    });
  }
};

exports.getCareerApplications = async (req, res) => {
  try {
    if (req.user?.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const applications = await prisma.careerApplication.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    return res.json({ applications });
  } catch (err) {
    console.error('getCareerApplications error:', err);
    return res.status(500).json({
      error: 'Failed to load applications.',
    });
  }
};

exports.downloadResume = async (req, res) => {
  try {
    const { applicationId } = req.params;

    const application = await prisma.careerApplication.findUnique({
      where: { id: applicationId },
    });

    if (!application || !application.resumePath) {
      return res.status(404).json({ error: 'Resume not found.' });
    }

    return res.download(
      path.resolve(application.resumePath),
      application.resumeName || 'resume.pdf'
    );
  } catch (err) {
    console.error('downloadResume error:', err);
    return res.status(500).json({
      error: 'Failed to download resume.',
    });
  }
};