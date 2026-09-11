const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-secret-change-me';
const TOKEN_TTL = '12h'; // a shift-length session is a reasonable default for a clinical tool

async function hashPassword(plain) {
  return bcrypt.hash(plain, 10);
}

async function checkPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

function signToken(staff) {
  return jwt.sign(
    {
      id: staff._id ? staff._id.toString() : staff.id,
      name: staff.name,
      email: staff.email,
      role: staff.role,
      department: staff.department || null,
      isAvailable: staff.isAvailable !== undefined ? staff.isAvailable : true,
    },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL }
  );
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

/**
 * requireAuth — attaches req.user from a valid Bearer token, or 401s.
 * Every /api/patients* route needs this: triage data shouldn't be
 * readable or writable by an unauthenticated caller.
 */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.user = verifyToken(token);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}

/**
 * requireRole('doctor','admin') — call after requireAuth. Blocks
 * roles that shouldn't perform a given action (e.g. only nurses and
 * doctors intake/override; a future 'viewer' role could read-only).
 */
function requireRole(...allowed) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (!allowed.includes(req.user.role)) {
      return res.status(403).json({ error: `This action requires role: ${allowed.join(' or ')}` });
    }
    next();
  };
}

module.exports = { hashPassword, checkPassword, signToken, verifyToken, requireAuth, requireRole };
