// Affiliate self-service routes.
// - GET  /dashboard         : sales, earnings, level, progress, notices
// - POST /promo-code        : set custom promo code (once, unless admin unlocks)
// - POST /discount-link     : generate a discount link from own commission
// - GET  /discount-links    : list own discount links
// - POST /withdraw          : request withdrawal
// - GET  /withdrawals       : list own withdrawals

const express = require('express');
const { z } = require('zod');
const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/roleCheck');
const { generateUniquePromoCode } = require('../utils/couponGenerator');
const asyncHandler = require('../lib/asyncHandler');

const router = express.Router();

// "Apply" is open to any authenticated user (that's how a USER becomes AFFILIATE).
router.post('/apply', requireAuth, asyncHandler(async (req, res) => {
  const existing = await prisma.affiliate.findUnique({ where: { userId: req.user.id } });
  if (existing) return res.json({ affiliate: existing, message: 'Already an affiliate.' });
  const aff = await prisma.affiliate.create({
    data: { userId: req.user.id, level: 'BRONZE', status: 'ACTIVE' },
  });
  await prisma.user.update({ where: { id: req.user.id }, data: { role: 'AFFILIATE' } });
  res.status(201).json({ affiliate: aff, message: 'Welcome! You are now an affiliate.' });
}));

// All remaining routes require an authenticated affiliate (or admin).
router.use(requireAuth, requireRole('AFFILIATE', 'ADMIN'));

// Level thresholds (sales count needed to unlock next tier)
const LEVELS = [
  { level: 'BRONZE',   minSales: 0 },
  { level: 'SILVER',   minSales: 10 },
  { level: 'GOLD',     minSales: 50 },
  { level: 'PLATINUM', minSales: 200 },
  { level: 'DIAMOND',  minSales: 1000 },
];

function progress(sales) {
  for (let i = LEVELS.length - 1; i >= 0; i--) {
    if (sales >= LEVELS[i].minSales) {
      const current = LEVELS[i];
      const next = LEVELS[i + 1] || null;
      const pct = next
        ? Math.round(((sales - current.minSales) / (next.minSales - current.minSales)) * 100)
        : 100;
      return { current: current.level, next: next?.level || null, progressPct: pct, salesToNext: next ? next.minSales - sales : 0 };
    }
  }
  return { current: 'BRONZE', next: 'SILVER', progressPct: 0, salesToNext: 10 };
}

router.get('/dashboard', asyncHandler(async (req, res) => {
  const aff = await prisma.affiliate.findUnique({ where: { userId: req.user.id } });
  if (!aff) return res.status(404).json({ error: 'Affiliate profile not found' });

  const [recentOrders, links, withdrawals, notices] = await Promise.all([
    prisma.order.findMany({
      where: { affiliateId: aff.id, status: { in: ['PAID','APPROVED','SHIPPED','DELIVERED'] } },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { orderNumber: true, total: true, status: true, createdAt: true },
    }),
    prisma.discountLink.findMany({ where: { affiliateId: aff.id, isActive: true } }),
    prisma.withdrawal.findMany({ where: { affiliateId: aff.id }, orderBy: { createdAt: 'desc' }, take: 20 }),
    prisma.notification.findMany({ where: { userId: req.user.id }, orderBy: { createdAt: 'desc' }, take: 5 }),
  ]);

  res.json({
    affiliate: {
      id: aff.id,
      level: aff.level, type: aff.type, status: aff.status,
      promoCode: aff.promoCode, promoCodeLocked: aff.promoCodeLocked,
      commissionRate: aff.commissionRate,
      totalSales: aff.totalSales, totalEarned: aff.totalEarned, balance: aff.balance,
    },
    progress: progress(aff.totalSales),
    recentOrders, discountLinks: links, withdrawals, notices,
  });
}));

router.post('/promo-code', asyncHandler(async (req, res) => {
  const { code } = z.object({ code: z.string().min(3).max(20).regex(/^[A-Za-z0-9_-]+$/) }).parse(req.body);
  const aff = await prisma.affiliate.findUnique({ where: { userId: req.user.id } });
  if (!aff) return res.status(404).json({ error: 'Affiliate profile not found' });
  if (aff.promoCodeLocked) return res.status(403).json({ error: 'Promo code is locked. Contact admin to change.' });

  const upper = code.toUpperCase();
  const clash = await prisma.affiliate.findUnique({ where: { promoCode: upper } });
  if (clash && clash.id !== aff.id) return res.status(409).json({ error: 'That code is taken.' });

  const updated = await prisma.affiliate.update({
    where: { id: aff.id },
    data: { promoCode: upper, promoCodeLocked: true },
  });
  res.json({ affiliate: updated });
}));

router.post('/discount-link', asyncHandler(async (req, res) => {
  const { discountPercent, maxUses, expiresAt } = z.object({
    discountPercent: z.number().min(1).max(50),
    maxUses: z.number().int().min(1).max(10_000).optional(),
    expiresAt: z.string().datetime().optional(),
  }).parse(req.body);

  const aff = await prisma.affiliate.findUnique({ where: { userId: req.user.id } });
  if (!aff) return res.status(404).json({ error: 'Affiliate profile not found' });

  // Affiliate's max giveaway = their default commission rate (fall back to 10)
  const maxAllowed = Number(aff.commissionRate ?? 10);
  if (discountPercent > maxAllowed) {
    return res.status(400).json({ error: `You can only give up to ${maxAllowed}% off (your commission rate).` });
  }
  const keep = Math.max(0, maxAllowed - discountPercent);

  const code = await generateUniquePromoCode(aff.promoCode || 'A');
  const link = await prisma.discountLink.create({
    data: {
      affiliateId: aff.id,
      code,
      discountPercent,
      affiliateKeepPercent: keep,
      maxUses: maxUses || null,
      expiresAt: expiresAt ? new Date(expiresAt) : null,
    },
  });
  res.json({ discountLink: link });
}));

router.get('/discount-links', asyncHandler(async (req, res) => {
  const aff = await prisma.affiliate.findUnique({ where: { userId: req.user.id } });
  if (!aff) return res.status(404).json({ error: 'Not an affiliate' });
  const links = await prisma.discountLink.findMany({
    where: { affiliateId: aff.id }, orderBy: { createdAt: 'desc' },
  });
  res.json({ discountLinks: links });
}));

router.post('/withdraw', asyncHandler(async (req, res) => {
  const { amount, method, destination } = z.object({
    amount: z.number().positive(),
    method: z.string().min(2).max(40),
    destination: z.string().min(3).max(300),
  }).parse(req.body);

  const aff = await prisma.affiliate.findUnique({ where: { userId: req.user.id } });
  if (!aff) return res.status(404).json({ error: 'Not an affiliate' });
  if (amount > Number(aff.balance)) return res.status(400).json({ error: 'Insufficient balance' });

  const w = await prisma.withdrawal.create({
    data: {
      affiliateId: aff.id,
      amount, method, destination,
      status: 'PENDING',
    },
  });
  // Reserve the funds
  await prisma.affiliate.update({
    where: { id: aff.id },
    data: { balance: { decrement: amount } },
  });
  res.status(201).json({ withdrawal: w });
}));

router.get('/withdrawals', asyncHandler(async (req, res) => {
  const aff = await prisma.affiliate.findUnique({ where: { userId: req.user.id } });
  if (!aff) return res.status(404).json({ error: 'Not an affiliate' });
  const items = await prisma.withdrawal.findMany({
    where: { affiliateId: aff.id }, orderBy: { createdAt: 'desc' },
  });
  res.json({ withdrawals: items });
}));

module.exports = router;
