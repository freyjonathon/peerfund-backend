// scripts/patch-loans.js
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  // Normalize any legacy Loan rows that still have null fees
  const r1 = await prisma.loan.updateMany({
    where: { bankingFee: null },
    data: { bankingFee: 0 },
  });
  const r2 = await prisma.loan.updateMany({
    where: { peerfundFee: null },
    data: { peerfundFee: 0 },
  });
  const r3 = await prisma.loan.updateMany({
    where: { totalFees: null },
    data: { totalFees: 0 },
  });

  console.log(`Patched Loans -> bankingFee: ${r1.count}, peerfundFee: ${r2.count}, totalFees: ${r3.count}`);
})()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
