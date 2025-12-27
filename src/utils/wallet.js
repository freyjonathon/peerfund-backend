// utils/wallet.js
const prisma = require('../utils/prisma');

async function getWalletOrCreate(userId) {
  let w = await prisma.wallet.findUnique({ where: { userId } });
  if (!w) w = await prisma.wallet.create({ data: { userId } });
  return w;
}

module.exports = { getWalletOrCreate };
