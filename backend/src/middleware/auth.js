// JWT authentication middleware.
// - `requireAuth` — 401 unless valid Bearer token.
// - `optionalAuth` — populates req.user if present, otherwise continues.

const { verifyToken } = require('../lib/jwt');
const prisma = require('../lib/prisma');

function getTokenFromReq(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  if (req.cookies?.token) return req.cookies.token;
  return null;
}

async function loadUser(req) {
  const token = getTokenFromReq(req);
  if (!token) return null;
  try {
    const payload = verifyToken(token);
    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true, email: true, username: true, displayName: true,
        role: true, isVerified: true, twoFactorEnabled: true,
      },
    });
    return user;
  } catch {
    return null;
  }
}

async function requireAuth(req, res, next) {
  const user = await loadUser(req);
  if (!user) return res.status(401).json({ error: 'Authentication required' });
  req.user = user;
  next();
}

async function optionalAuth(req, _res, next) {
  req.user = await loadUser(req);
  next();
}

async function requireVerified(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  if (!req.user.isVerified) return res.status(403).json({ error: 'Email not verified' });
  next();
}

module.exports = { requireAuth, optionalAuth, requireVerified };
