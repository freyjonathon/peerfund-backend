// server.js
require('dotenv').config();

const express = require('express');
console.log("✅ PeerFund backend booted:", new Date().toISOString());

const cron = require('node-cron');
const cookieParser = require('cookie-parser');

const runAutoRepayments = require('./cron/processAutoRepayments');
const { authenticateToken } = require('./middleware/authMiddleware');

// Routers
const authRoutes = require('./routes/authRoutes');
const adminRoutes = require('./routes/adminRoutes');
const offerRoutes = require('./routes/offerRoutes');
const contractRoutes = require('./routes/contractRoutes');
const matchRoutes = require('./routes/matchRoutes');
const userRoutes = require('./routes/userRoutes');
const loanRoutes = require('./routes/loanRoutes');
const messageRoutes = require('./routes/messageRoutes');
const repaymentRoutes = require('./routes/repaymentRoutes');
const paymentMethodRoutes = require('./routes/paymentMethodRoutes');
const transactionRoutes = require('./routes/transactionRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const documentRoutes = require('./routes/documentRoutes');
const postRoutes = require('./routes/postRoutes');
const statsRoutes = require('./routes/statsRoutes');
const loanMessageRoutes = require('./routes/loanMessageRoutes');
const inlineDiscussionRoutes = require('./routes/inlineDiscussionRoutes');
const verificationRoutes = require('./routes/verificationRoutes');
const paymentsRoutes = require('./routes/payments');
const directRequestRoutes = require('./routes/directRequestRoutes');
const stripeRoutes = require('./routes/stripeRoutes'); // normal JSON routes

// ✅ Admin transactions routes (make sure this file exists)
const adminTransactionRoutes = require('./routes/adminTransactionRoutes');

// Wallet
const walletRoutes = require('./routes/walletRoutes');
const walletController = require('./controllers/walletController');
const billingRoutes = require('./routes/billingRoutes');

// Webhook controllers
const paymentsController = require('./controllers/paymentsController');
const { getPublicUserProfileById } = require('./controllers/userController');

// Stripe funding webhook handler
const stripeFundingWebhook =
  require('./controllers/stripeWebhookController').handleStripeWebhook;

const app = express();
app.disable('x-powered-by');

/* ----------------------------- CORS ----------------------------- */
const ORIGINS = (
  process.env.FRONTEND_ORIGIN || 'http://localhost:3000,http://127.0.0.1:3000'
)
  .split(',')
  .map((s) => s.trim());

function originAllowed(origin) {
  return !origin || ORIGINS.includes(origin);
}

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (originAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin || ORIGINS[0]);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader(
      'Access-Control-Allow-Methods',
      'GET,POST,PUT,PATCH,DELETE,OPTIONS'
    );
    const reqHeaders = req.headers['access-control-request-headers'];
    res.setHeader(
      'Access-Control-Allow-Headers',
      reqHeaders || 'Content-Type, Authorization'
    );
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

/* -------------------- RAW webhooks (before JSON) -------------------- */

// 1) Subscription / SuperUser webhook
app.post(
  '/api/payments/webhook',
  express.raw({ type: 'application/json' }),
  (req, _res, next) => {
    req.rawBody = req.body;
    next();
  },
  paymentsController.webhook
);

// 2) Wallet webhook
app.post(
  '/api/wallet/webhook/stripe',
  express.raw({ type: 'application/json' }),
  (req, _res, next) => {
    req.rawBody = req.body;
    next();
  },
  walletController.stripeWebhook
);

// 3) Loan funding webhook (destination charges / transfers)
app.post(
  '/api/stripe/webhook',
  express.raw({ type: 'application/json' }),
  (req, _res, next) => {
    req.rawBody = req.body;
    next();
  },
  stripeFundingWebhook
);

/* ---------------------------- Parsers ------------------------------- */
app.use(cookieParser());

// JSON parser AFTER raw webhook routes
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

/* ---------------------------- Routes -------------------------------- */

app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);

app.use('/api/offers', offerRoutes);
app.use('/api/contracts', contractRoutes);
app.use('/api/match-loans', matchRoutes);
app.use('/api/users', userRoutes);
app.use('/api/loans', loanRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/repayments', repaymentRoutes);
app.use('/api/payment-method', paymentMethodRoutes);
app.use('/api/transactions', transactionRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/posts', postRoutes);
app.use('/api/leaderboard', statsRoutes);
app.use('/api/loanMessages', loanMessageRoutes);

app.use('/api', inlineDiscussionRoutes);
app.use('/api', verificationRoutes);
app.use('/api/direct-requests', directRequestRoutes);
app.use('/api/billing', billingRoutes);

// ✅ Admin transactions endpoint (so /api/admin/transactions works)
app.use('/api', adminTransactionRoutes);

// ✅ other Stripe JSON routes (ensure-customer, onboarding, etc.)
app.use('/api/stripe', stripeRoutes);

// Wallet protected routes (webhook excluded above)
app.use('/api/wallet', authenticateToken, walletRoutes);

// Payments protected routes (webhook excluded above)
app.use('/api/payments', authenticateToken, paymentsRoutes);

/* ------------------------ Convenience route ------------------------- */
app.get('/api/profile/:id', getPublicUserProfileById);

/* ---------------------- Healthcheck endpoint ------------------------ */
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

/* ------------------------- Prisma Connection ------------------------ */
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async function testConnection() {
  try {
    await prisma.$connect();
    console.log('✅ Connected to MongoDB Atlas via Prisma');
  } catch (err) {
    console.error('❌ Prisma connection failed:', err);
    process.exit(1);
  }
})();

/* ------------------------------ Cron -------------------------------- */
cron.schedule('0 0 * * *', async () => {
  console.log('🔁 Running scheduled auto-repayment cron job...');
  try {
    await runAutoRepayments();
    console.log('✅ Auto-repayments completed successfully.');
  } catch (err) {
    console.error('❌ Auto-repayment cron failed:', err);
  }
});

/* --------------------------- Error handler --------------------------- */
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  if (!res.headersSent) res.status(500).json({ message: 'Internal server error' });
});

/* ---------------------------- Startup ------------------------------- */
const PORT = process.env.PORT || 5050;
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`CORS origins allowed: ${ORIGINS.join(', ')}`);
});
