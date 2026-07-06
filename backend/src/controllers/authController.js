// Auth controller: register, verify OTP, login (with optional 2FA),
// forgot/reset password, 2FA enrollment.

const bcrypt = require('bcryptjs');
const speakeasy = require('speakeasy');
const { z } = require('zod');

const prisma = require('../lib/prisma');
const { signToken } = require('../lib/jwt');
const {
  sendOtpEmail,
  sendPasswordResetEmail,
} = require('../lib/email');
const { generateUniqueUsername } = require('../utils/usernameGenerator');
const { generateNumericOtp, randomCode } = require('../utils/couponGenerator');

const BCRYPT_ROUNDS = Number(process.env.BCRYPT_ROUNDS || 10);
const OTP_TTL_MS = 5 * 60 * 1000;

// ---------- Schemas ----------
const registerSchema = z.object({
  email: z.string().email().max(160),
  password: z.string().min(8).max(128),
  displayName: z.string().min(2).max(60),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  twoFactorCode: z.string().optional(),
});

const verifyOtpSchema = z.object({
  email: z.string().email(),
  otp: z.string().length(6),
});

const forgotSchema = z.object({ email: z.string().email() });

const resetSchema = z.object({
  token: z.string().min(10),
  password: z.string().min(8).max(128),
});

// ---------- Helpers ----------
function toJwtPayload(user) {
  return { sub: user.id, role: user.role, email: user.email };
}

function safeUser(user) {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    isVerified: user.isVerified,
    twoFactorEnabled: user.twoFactorEnabled,
  };
}

// ---------- Handlers ----------

async function register(req, res) {
  const data = registerSchema.parse(req.body);
  const existing = await prisma.user.findUnique({ where: { email: data.email.toLowerCase() } });
  if (existing) {
    return res.status(409).json({ error: 'An account with that email already exists.' });
  }

  const passwordHash = await bcrypt.hash(data.password, BCRYPT_ROUNDS);
  const username = await generateUniqueUsername(data.displayName);
  const otp = generateNumericOtp(6);

  const user = await prisma.user.create({
    data: {
      email: data.email.toLowerCase(),
      passwordHash,
      displayName: data.displayName.trim(),
      username,
      otpCode: otp,
      otpExpiresAt: new Date(Date.now() + OTP_TTL_MS),
    },
  });

  // Fire-and-log the email; do NOT block registration if it fails.
  sendOtpEmail(user.email, otp).catch(err => {
    console.error('[auth.register] OTP email failed:', err.message);
  });

  return res.status(201).json({
    message: 'Account created. Check your email for a 6-digit verification code.',
    user: safeUser(user),
    // Never return the OTP in production; helpful in dev only.
    ...(process.env.NODE_ENV !== 'production' && { devOtp: otp }),
  });
}

async function verifyOtp(req, res) {
  const { email, otp } = verifyOtpSchema.parse(req.body);
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (!user) return res.status(404).json({ error: 'Account not found' });
  if (user.isVerified) return res.json({ message: 'Already verified', user: safeUser(user) });
  if (!user.otpCode || !user.otpExpiresAt) {
    return res.status(400).json({ error: 'No OTP pending. Request a new one.' });
  }
  if (user.otpExpiresAt < new Date()) {
    return res.status(400).json({ error: 'OTP expired. Request a new one.' });
  }
  if (user.otpCode !== otp) {
    return res.status(400).json({ error: 'Invalid OTP.' });
  }

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { isVerified: true, otpCode: null, otpExpiresAt: null },
  });

  const token = signToken(toJwtPayload(updated));
  return res.json({ message: 'Email verified', user: safeUser(updated), token });
}

async function resendOtp(req, res) {
  const { email } = z.object({ email: z.string().email() }).parse(req.body);
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (!user) return res.status(404).json({ error: 'Account not found' });
  if (user.isVerified) return res.json({ message: 'Already verified' });

  const otp = generateNumericOtp(6);
  await prisma.user.update({
    where: { id: user.id },
    data: { otpCode: otp, otpExpiresAt: new Date(Date.now() + OTP_TTL_MS) },
  });
  sendOtpEmail(user.email, otp).catch(err => console.error('[auth.resendOtp]', err.message));
  return res.json({
    message: 'A new code was sent to your email.',
    ...(process.env.NODE_ENV !== 'production' && { devOtp: otp }),
  });
}

async function login(req, res) {
  const { email, password, twoFactorCode } = loginSchema.parse(req.body);
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

  if (!user.isVerified) {
    return res.status(403).json({
      error: 'Email not verified',
      code: 'NOT_VERIFIED',
      email: user.email,
    });
  }

  if (user.twoFactorEnabled) {
    if (!twoFactorCode) {
      return res.status(200).json({ requires2FA: true });
    }
    const valid = speakeasy.totp.verify({
      secret: user.twoFactorSecret,
      encoding: 'base32',
      token: twoFactorCode,
      window: 1,
    });
    if (!valid) return res.status(401).json({ error: 'Invalid 2FA code' });
  }

  const token = signToken(toJwtPayload(user));
  return res.json({ token, user: safeUser(user) });
}

async function me(req, res) {
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    include: { affiliate: true },
  });
  if (!user) return res.status(404).json({ error: 'Not found' });
  return res.json({
    user: safeUser(user),
    affiliate: user.affiliate ? {
      id: user.affiliate.id,
      level: user.affiliate.level,
      type: user.affiliate.type,
      status: user.affiliate.status,
      promoCode: user.affiliate.promoCode,
      promoCodeLocked: user.affiliate.promoCodeLocked,
      totalEarned: user.affiliate.totalEarned,
      balance: user.affiliate.balance,
      totalSales: user.affiliate.totalSales,
    } : null,
  });
}

async function forgotPassword(req, res) {
  const { email } = forgotSchema.parse(req.body);
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  // Always respond 200 to avoid email enumeration.
  if (!user) return res.json({ message: 'If that email exists, a reset link was sent.' });

  const token = randomCode(32);
  await prisma.user.update({
    where: { id: user.id },
    data: { resetToken: token, resetTokenExpiry: new Date(Date.now() + 30 * 60 * 1000) },
  });
  const link = `${process.env.FRONTEND_URL || ''}/login.html?reset=${token}`;
  sendPasswordResetEmail(user.email, link).catch(err =>
    console.error('[auth.forgotPassword]', err.message)
  );
  return res.json({ message: 'If that email exists, a reset link was sent.' });
}

async function resetPassword(req, res) {
  const { token, password } = resetSchema.parse(req.body);
  const user = await prisma.user.findFirst({
    where: {
      resetToken: token,
      resetTokenExpiry: { gt: new Date() },
    },
  });
  if (!user) return res.status(400).json({ error: 'Invalid or expired reset link.' });

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash, resetToken: null, resetTokenExpiry: null },
  });
  return res.json({ message: 'Password reset. Please log in.' });
}

// ---------- 2FA ----------
async function twoFactorSetup(req, res) {
  const secret = speakeasy.generateSecret({
    name: `Fiad Shop (${req.user.email})`,
    length: 20,
  });
  await prisma.user.update({
    where: { id: req.user.id },
    data: { twoFactorSecret: secret.base32, twoFactorEnabled: false },
  });
  return res.json({
    secret: secret.base32,
    otpauthUrl: secret.otpauth_url,
  });
}

async function twoFactorVerify(req, res) {
  const { code } = z.object({ code: z.string().length(6) }).parse(req.body);
  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (!user.twoFactorSecret) return res.status(400).json({ error: 'Run setup first.' });

  const valid = speakeasy.totp.verify({
    secret: user.twoFactorSecret,
    encoding: 'base32',
    token: code,
    window: 1,
  });
  if (!valid) return res.status(400).json({ error: 'Invalid code.' });

  await prisma.user.update({
    where: { id: user.id },
    data: { twoFactorEnabled: true },
  });
  return res.json({ message: '2FA enabled.' });
}

async function twoFactorDisable(req, res) {
  await prisma.user.update({
    where: { id: req.user.id },
    data: { twoFactorEnabled: false, twoFactorSecret: null },
  });
  return res.json({ message: '2FA disabled.' });
}

module.exports = {
  register,
  verifyOtp,
  resendOtp,
  login,
  me,
  forgotPassword,
  resetPassword,
  twoFactorSetup,
  twoFactorVerify,
  twoFactorDisable,
};
