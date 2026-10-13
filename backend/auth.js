const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-secret-change-me';
const TOKEN_TTL = '12h';

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
 * requireAuth - attaches req.user from an httpOnly cookie or valid Bearer token, or returns 401.
 */
function requireAuth(req, res, next) {
  let token = null;

  if (req.cookies && req.cookies.pt_token) {
    token = req.cookies.pt_token;
  } else if (req.headers && req.headers.authorization) {
    const header = req.headers.authorization;
    if (header.startsWith('Bearer ')) {
      token = header.slice(7);
    }
  }

  if (!token) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    req.user = verifyToken(token);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}

/**
 * requireRole - verifies user has one of the allowed roles.
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

module.exports = {
  hashPassword,
  checkPassword,
  signToken,
  verifyToken,
  requireAuth,
  requireRole,
  JWT_SECRET,
};