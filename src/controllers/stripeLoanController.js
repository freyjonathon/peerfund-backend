// src/controllers/stripeLoanController.js
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

/**
 * GET /api/stripe/has-loan-payment-method
 * Returns { hasLoanPaymentMethod: boolean }
 */
exports.hasLoanPaymentMethod = async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const pm = await prisma.paymentMethod.findFirst({
      where: {
        userId,
        isForLoans: true,  // <--- THIS is the important part
      },
    });

    return res.json({ hasLoanPaymentMethod: !!pm });
  } catch (err) {
    console.error('Error checking loan payment method:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * POST /api/stripe/save-loan-payment-method
 * Body: { paymentMethodId }
 */
exports.saveLoanPaymentMethod = async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { paymentMethodId } = req.body;
    if (!paymentMethodId) {
      return res.status(400).json({ error: 'Missing paymentMethodId' });
    }

    // 🔹 Mark all OTHER existing loan PMs as false (optional safety)
    await prisma.paymentMethod.updateMany({
      where: { userId, isForLoans: true },
      data: { isForLoans: false },
    });

    // 🔹 Upsert this new PM as the loan disbursement method
    const saved = await prisma.paymentMethod.upsert({
      where: { stripePaymentMethodId: paymentMethodId },
      update: { isForLoans: true },
      create: {
        userId,
        stripePaymentMethodId: paymentMethodId,
        brand: 'us_bank_account',
        isDefault: false,
        isForLoans: true,
      },
    });

    return res.json({ success: true, paymentMethodId: saved.stripePaymentMethodId });
  } catch (err) {
    console.error('Error saving loan payment method:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
