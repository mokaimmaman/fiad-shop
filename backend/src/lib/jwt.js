// Thin JWT wrapper.

const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET;
const EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

if (!SECRET && process.env.NODE_ENV === 'production') {
  console.error('FATAL: JWT_SECRET is not set.');
}

function signToken(payload, opts = {}) {
  return jwt.sign(payload, SECRET || 'dev-secret-change-me', {
    expiresIn: EXPIRES_IN,
    ...opts,
  });
}

function verifyToken(token) {
  return jwt.verify(token, SECRET || 'dev-secret-change-me');
}

module.exports = { signToken, verifyToken };
