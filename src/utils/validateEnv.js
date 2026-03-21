// utils/validateEnv.js

function requireEnv(name) {
  const value = process.env[name];
  if (!value || !String(value).trim()) {
    throw new Error(`❌ Missing required environment variable: ${name}`);
  }
  return String(value).trim();
}

function requirePrefix(name, prefix) {
  const value = requireEnv(name);
  if (!value.startsWith(prefix)) {
    throw new Error(`❌ ${name} must start with ${prefix}`);
  }
  return value;
}

function validateEnv() {
  console.log('🔍 Validating environment variables...');

  // Core
  requireEnv('DATABASE_URL');
  requireEnv('JWT_SECRET');

  // Stripe (critical)
  const stripeSecret = requirePrefix('STRIPE_SECRET_KEY', 'sk_');
  requirePrefix('STRIPE_WEBHOOK_SECRET', 'whsec_');

  // Origins
  requireEnv('FRONTEND_ORIGIN');
  requireEnv('API_ORIGIN');

  // Mode detection
  const isLive = stripeSecret.startsWith('sk_live_');
  const isTest = stripeSecret.startsWith('sk_test_');

  if (!isLive && !isTest) {
    throw new Error('❌ STRIPE_SECRET_KEY must be a valid Stripe key');
  }

  // 🔥 CRITICAL: enforce publishable key match (optional but recommended)
  const publishable = process.env.REACT_APP_STRIPE_PUBLISHABLE_KEY;

  if (publishable) {
    const pubIsLive = publishable.startsWith('pk_live_');
    const pubIsTest = publishable.startsWith('pk_test_');

    if (isLive && !pubIsLive) {
      throw new Error('❌ Mismatch: LIVE secret key with TEST publishable key');
    }

    if (isTest && !pubIsTest) {
      throw new Error('❌ Mismatch: TEST secret key with LIVE publishable key');
    }
  }

  console.log('✅ Environment validated');
  console.log(`💳 Stripe mode: ${isLive ? 'LIVE' : 'TEST'}`);
  console.log(`🔐 Stripe key prefix: ${stripeSecret.slice(0, 7)}`);
}

module.exports = { validateEnv };