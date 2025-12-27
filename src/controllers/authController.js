const prisma = require('../utils/prisma');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const SALT_ROUNDS = 10;

// --- helpers -------------------------------------------------
const digitsOnly = (s) => String(s || '').replace(/\D+/g, '');
const normalizeEmail = (e) => String(e || '').trim().toLowerCase();

function assertJwtSecret() {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is not set');
}
function makeToken(payload, expiresIn = '1h') {
  assertJwtSecret();
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn });
}

// POST /api/auth/register  (unchanged except ensure digits only for phone)
exports.registerUser = async (req, res) => {
  try {
    const { name, email, phone, password } = req.body || {};
    if (!name || !email || !phone || !password) {
      return res.status(400).json({ error: 'All fields required' });
    }

    const emailNorm = normalizeEmail(email);
    const phoneNorm = digitsOnly(phone);
    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

    const newUser = await prisma.user.create({
      data: {
        name: String(name).trim(),
        email: emailNorm,
        phone: phoneNorm,
        password: hashedPassword,
      },
    });

    const token = makeToken({
      userId: newUser.id,
      name: newUser.name,
      email: newUser.email,
      role: newUser.role || 'USER',
    });

    return res.status(201).json({ token });
  } catch (err) {
    if (err?.code === 'P2002') {
      const target = Array.isArray(err?.meta?.target) ? err.meta.target.join(',') : err?.meta?.target;
      return res.status(409).json({ error: `${target || 'unique field'} already in use` });
    }
    console.error('Registration error:', err);
    return res.status(500).json({ error: 'Registration failed' });
  }
};

// POST /api/auth/login
exports.loginUser = async (req, res) => {
  try {
    const { email, phone, password } = req.body || {};
    if (!password || (!email && !phone)) {
      return res.status(400).json({ error: 'Missing credentials' });
    }

    const emailNorm = email ? normalizeEmail(email) : null;
    const phoneNorm = phone ? digitsOnly(phone) : null;

    let user = null;
    if (emailNorm) {
      user = await prisma.user.findUnique({ where: { email: emailNorm } });
    } else if (phoneNorm) {
      user = await prisma.user.findUnique({ where: { phone: phoneNorm } });
    }

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const ok = await bcrypt.compare(String(password), user.password);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    const token = makeToken({
      userId: user.id,
      role: user.role || 'USER',
      email: user.email,
      name: user.name,
    });

    return res.status(200).json({ token });
  } catch (err) {
    // Don’t leak a 500 on common auth mistakes
    console.error('Login error:', err);
    return res.status(500).json({ error: 'Login failed' });
  }
};
