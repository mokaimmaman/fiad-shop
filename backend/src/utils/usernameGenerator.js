// Generate a URL-safe unique username from a display name.

const prisma = require('../lib/prisma');

function slugify(s) {
  return String(s || 'user')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 20) || 'user';
}

/** Returns a unique username; appends random digits until unused. */
async function generateUniqueUsername(displayName) {
  const base = slugify(displayName);
  for (let attempt = 0; attempt < 8; attempt++) {
    const suffix = Math.floor(1000 + Math.random() * 9000); // 4 digits
    const candidate = `${base}_${suffix}`.slice(0, 30);
    const exists = await prisma.user.findUnique({ where: { username: candidate } });
    if (!exists) return candidate;
  }
  // Fallback with timestamp
  return `${base}_${Date.now().toString(36)}`.slice(0, 30);
}

module.exports = { generateUniqueUsername, slugify };
