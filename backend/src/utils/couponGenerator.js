// Coupon / promo code generator: readable, unambiguous alphanumeric.

const prisma = require('../lib/prisma');

// Excludes 0/O/1/I/L for readability.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function randomCode(len = 8, prefix = '') {
  let out = prefix;
  for (let i = 0; i < len; i++) {
    out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return out;
}

async function generateUniqueCouponCode(prefix = 'FIAD') {
  for (let i = 0; i < 8; i++) {
    const code = randomCode(8, `${prefix}-`);
    const exists = await prisma.coupon.findUnique({ where: { code } });
    if (!exists) return code;
  }
  return `${prefix}-${Date.now().toString(36).toUpperCase()}`;
}

async function generateUniquePromoCode(prefix) {
  for (let i = 0; i < 8; i++) {
    const code = randomCode(6, prefix ? `${prefix.toUpperCase()}-` : '');
    const [a, d] = await Promise.all([
      prisma.affiliate.findUnique({ where: { promoCode: code } }),
      prisma.discountLink.findUnique({ where: { code } }),
    ]);
    if (!a && !d) return code;
  }
  return `PROMO-${Date.now().toString(36).toUpperCase()}`;
}

function generateOrderNumber() {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = randomCode(4);
  return `FS-${ts}-${rand}`;
}

function generateNumericOtp(len = 6) {
  let out = '';
  for (let i = 0; i < len; i++) out += Math.floor(Math.random() * 10);
  return out;
}

module.exports = {
  randomCode,
  generateUniqueCouponCode,
  generateUniquePromoCode,
  generateOrderNumber,
  generateNumericOtp,
};
