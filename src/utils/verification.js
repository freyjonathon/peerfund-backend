// utils/verification.js
const prisma = require('../utils/prisma');

const REQUIRED_PAYSTUBS = 0; // or keep >0 if you still want paystubs later

async function getVerificationChecklist(userId) {
  const [docs, user] = await Promise.all([
    prisma.document.findMany({
      where: { userId },
      select: { type: true },
    }),
    prisma.user.findUnique({
      where: { id: userId },
      select: { verificationStatus: true },
    }),
  ]);

  const types = docs.map((d) => d.type);

  const hasIdFront = types.includes('ID_FRONT');
  const hasIdBack  = types.includes('ID_BACK');
  const hasSelfie  = types.includes('SELFIE');

  const paystubCount = docs.filter((d) => d.type === 'PAYSTUB').length;

  return {
    status: user?.verificationStatus || 'PENDING',
    hasIdFront,
    hasIdBack,
    hasSelfie,
    paystubCount,
    // keep backwards-compat flags if you still reference them
    hasPhotoId: hasIdFront && hasIdBack,
  };
}

module.exports = {
  getVerificationChecklist,
  REQUIRED_PAYSTUBS,
};
