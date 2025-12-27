// middleware/requireVerified.js
module.exports = function requireVerified(req, res, next) {
  const user = req.user;
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  if (user.verificationStatus !== 'APPROVED') {
    return res.status(403).json({ error: 'Verification required' });
  }

  next();
};
