// middleware/authMiddleware.js
const jwt = require('jsonwebtoken');
const prisma = require('../utils/prisma');

/** Extract a token from Authorization in as many shapes as possible. */
function extractTokenFromAuthorization(req) {
  let h = req.headers.authorization || '';
  if (!h) return null;

  h = h.trim().replace(/^"|"$/g, ''); // strip accidental quotes

  // If it's exactly one chunk (no space), treat as raw token.
  if (!/\s/.test(h)) return h;

  // Otherwise expect "Bearer <token>" (case-insensitive) or ignore.
  const [scheme, ...rest] = h.split(/\s+/);
  if (scheme && scheme.toLowerCase() === 'bearer') {
    const token = rest.join(' ').trim();
    return token || null;
  }
  // Unknown scheme; treat the rest as token if present
  const fallback = rest.join(' ').trim();
  return fallback || null;
}

function getTokenFromReq(req) {
  return (
    extractTokenFromAuthorization(req) ||
    (req.headers['x-access-token'] ? String(req.headers['x-access-token']).trim().replace(/^"|"$/g, '') : null) ||
    (req.cookies?.token ? String(req.cookies.token).trim().replace(/^"|"$/g, '') : null) ||
    (req.query?.token ? String(req.query.token).trim().replace(/^"|"$/g, '') : null) ||
    null
  );
}

/** Normalize decoded claims into a consistent req.user shape */
function attachDecodedUser(req, decoded) {
  const id =
    decoded.id ??
    decoded.userId ??
    decoded.userid ??
    decoded.sub ??
    null;

  if (!id) return null;

  const normId = String(id);
  const user = {
    id: normId,          // canonical
    userId: normId,      // backward-compat
    email: decoded.email ?? null,
    role: decoded.role ?? decoded.claims?.role ?? null,
    stripeCustomerId: decoded.stripeCustomerId ?? null,
    ...decoded,          // keep any extra claims you rely on
  };

  req.user = user;
  if (req.res) req.res.locals.user = user;
  return normId;
}

/** Optional auth: attaches req.user when token is valid; otherwise continues */
function optionalAuth(req, _res, next) {
  const token = getTokenFromReq(req);
  if (!token) return next();

  try {
    if (!process.env.JWT_SECRET) {
      console.warn('optionalAuth: JWT_SECRET is not set');
      return next();
    }
    const decoded = jwt.verify(token, process.env.JWT_SECRET /*, { algorithms: ['HS256'] }*/);
    const ok = attachDecodedUser(req, decoded);
    if (!ok) console.warn('optionalAuth: token missing id/userId/sub claim');
  } catch (err) {
    console.warn('optionalAuth: invalid token ignored:', err.message);
  }
  next();
}

/** Hard auth: requires a valid token; sends 401 on failure */
function authenticateToken(req, res, next) {
  const token = getTokenFromReq(req);
  if (!token) {
    return res.status(401).json({ message: 'Unauthorized: token required' });
  }

  try {
    if (!process.env.JWT_SECRET) {
      console.error('authenticateToken: JWT_SECRET is not set');
      return res.status(500).json({ message: 'Server misconfiguration' });
    }
    const decoded = jwt.verify(token, process.env.JWT_SECRET /*, { algorithms: ['HS256'] }*/);
    const ok = attachDecodedUser(req, decoded);
    if (!ok) {
      return res.status(401).json({ message: 'Invalid token: missing user id' });
    }
    return next();
  } catch (err) {
    console.error('authenticateToken: token verification failed:', err.message);
    return res.status(401).json({ message: 'Unauthorized: invalid or expired token' });
  }
}

/** Helper to read the normalized user id safely */
function getUserId(req) {
  return req?.user?.id ?? null;
}

/** Require ADMIN role (assumes authenticateToken ran already) */
async function requireAdmin(req, res, next) {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });

    if (user?.role === 'ADMIN') return next();
    return res.status(403).json({ message: 'Access denied. Admins only.' });
  } catch (err) {
    console.error('requireAdmin error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
}

module.exports = {
  optionalAuth,
  authenticateToken,
  requireAdmin,
  getUserId,
};
