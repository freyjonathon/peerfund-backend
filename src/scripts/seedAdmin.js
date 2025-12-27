// scripts/seedAdmin.js
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');

const prisma = new PrismaClient();
const SALT_ROUNDS = 10;

async function seedAdmin() {
  const password = await bcrypt.hash('SuperSecret123!', SALT_ROUNDS); // You can change this password

  // Check if admin already exists
  const existing = await prisma.user.findFirst({
    where: { phone: '9999999999' } // Use a unique phone number
  });

  if (existing) {
    console.log('✅ Admin user already exists.');
    return;
  }

  // Create admin user
  await prisma.user.create({
    data: {
      name: 'Admin',
      phone: '9999999999',
      password,
      role: 'ADMIN'
    }
  });

  console.log('✅ Admin user created with phone 9999999999');
}

seedAdmin()
  .catch((err) => {
    console.error('❌ Error seeding admin:', err);
  })
  .finally(() => prisma.$disconnect());
