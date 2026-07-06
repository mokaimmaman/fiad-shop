// Admin panel APIs. Every route requires role=ADMIN (some also allow MODERATOR).

const express = require('express');
const { z } = require('zod');
const bcrypt = require('bcryptjs');
const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/roleCheck');
const asyncHandler = require('../lib/asyncHandler');
const { generateUniqueCouponCode } = require('../utils/couponGenerator');
const { sendCouponEmail } = require('../lib/email');
const { sendShippedNotice } = require('../controllers/orderController');

const router = express.Router();

router.use(requireAuth, requireRole('ADMIN', 'MODERATOR'));

// -----------------------------------------------------------------------------
// Dashboard summary
// -----------------------------------------------------------------------------
router.get('/dashboard', asyncHandler(async (_req, res) => {
  const [orders, users, affiliates, revenue, pendingFeedback, activeSessions] = await Promise.all([
    prisma.order.count(),
    prisma.user.count(),
    prisma.affiliate.count(),
    prisma.order.aggregate({ _sum: { total: true }, where: { status: { in: ['PAID','APPROVED','SHIPPED','DELIVERED'] } } }),
    prisma.feedback.count({ where: { status: 'PENDING' } }),
    prisma.liveSupportSession.count({ where: { status: { in: ['ACTIVE','WAITING'] } } }),
  ]);
  const recentOrders = await prisma.order.findMany({
    orderBy: { createdAt: 'desc' }, take: 10,
    select: { id: true, orderNumber: true, total: true, status: true, createdAt: true, guestEmail: true, userId: true },
  });
  res.json({
    counts: { orders, users, affiliates, pendingFeedback, activeSessions },
    revenue: revenue._sum.total || 0,
    recentOrders,
  });
}));

// -----------------------------------------------------------------------------
// PRODUCTS
// -----------------------------------------------------------------------------
const productSchema = z.object({
  sku: z.string().min(1).max(80),
  pid: z.string().min(1).max(80),
  name: z.string().min(1).max(200),
  description: z.string().max(20000),
  category: z.string().min(1).max(80),
  basePrice: z.number().nonnegative(),
  images: z.array(z.string().url()).min(1).max(20),
  affiliateCommission: z.number().min(0).max(90).default(0),
  isProMode: z.boolean().default(false),
  isPackage: z.boolean().default(false),
  isActive: z.boolean().default(true),
  stock: z.number().int().min(0).default(0),
  variants: z.array(z.object({
    color: z.string().optional().nullable(),
    size: z.string().optional().nullable(),
    material: z.string().optional().nullable(),
    priceOverride: z.number().optional().nullable(),
    stock: z.number().int().min(0).default(0),
  })).optional(),
  packageItems: z.array(z.object({
    childProductId: z.string(),
    quantity: z.number().int().min(1),
  })).optional(),
});

router.get('/products', asyncHandler(async (req, res) => {
  const items = await prisma.product.findMany({
    orderBy: { createdAt: 'desc' },
    include: { variants: true, packageItems: true },
    take: 500,
  });
  res.json({ items });
}));

router.post('/products', asyncHandler(async (req, res) => {
  const data = productSchema.parse(req.body);
  const { variants = [], packageItems = [], ...prod } = data;
  const created = await prisma.product.create({
    data: {
      ...prod,
      variants: { create: variants },
      packageItems: { create: packageItems },
    },
    include: { variants: true, packageItems: true },
  });
  res.status(201).json({ product: created });
}));

router.put('/products/:id', asyncHandler(async (req, res) => {
  const data = productSchema.partial().parse(req.body);
  const { variants, packageItems, ...prod } = data;

  // Do variant/packageItem replace-all in a transaction for simplicity.
  const updated = await prisma.$transaction(async (tx) => {
    const p = await tx.product.update({ where: { id: req.params.id }, data: prod });
    if (variants) {
      await tx.productVariant.deleteMany({ where: { productId: p.id } });
      if (variants.length) {
        await tx.productVariant.createMany({
          data: variants.map(v => ({ ...v, productId: p.id })),
        });
      }
    }
    if (packageItems) {
      await tx.packageItem.deleteMany({ where: { packageId: p.id } });
      if (packageItems.length) {
        await tx.packageItem.createMany({
          data: packageItems.map(pi => ({ ...pi, packageId: p.id })),
        });
      }
    }
    return tx.product.findUnique({
      where: { id: p.id },
      include: { variants: true, packageItems: true },
    });
  });
  res.json({ product: updated });
}));

router.delete('/products/:id', asyncHandler(async (req, res) => {
  await prisma.product.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
}));

// -----------------------------------------------------------------------------
// ORDERS
// -----------------------------------------------------------------------------
router.get('/orders', asyncHandler(async (req, res) => {
  const { status, affiliateId, from, to } = req.query;
  const where = {};
  if (status) where.status = status;
  if (affiliateId) where.affiliateId = affiliateId;
  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt.gte = new Date(from);
    if (to) where.createdAt.lte = new Date(to);
  }
  const orders = await prisma.order.findMany({
    where, orderBy: { createdAt: 'desc' }, take: 200,
    include: { items: true, user: { select: { email: true, displayName: true } } },
  });
  res.json({ orders });
}));

router.get('/orders/:id', asyncHandler(async (req, res) => {
  const order = await prisma.order.findUnique({
    where: { id: req.params.id },
    include: {
      items: { include: { product: { select: { sku: true, pid: true, name: true } } } },
      user: { select: { email: true, displayName: true, username: true } },
      affiliate: { include: { user: { select: { displayName: true, email: true } } } },
      coupon: true,
    },
  });
  if (!order) return res.status(404).json({ error: 'Not found' });
  res.json({ order });
}));

router.post('/orders/:id/approve', asyncHandler(async (req, res) => {
  const order = await prisma.order.update({
    where: { id: req.params.id },
    data: { status: 'APPROVED' },
    include: {
      items: { include: { product: { select: { sku: true, pid: true, name: true } } } },
    },
  });
  // Build "CJ forward" payload the admin can copy
  const cjForward = {
    shippingAddress: order.shippingAddress,
    items: order.items.map(i => ({
      sku: i.sku, pid: i.product?.pid, name: i.name, quantity: i.quantity, variant: i.variantJson,
    })),
    orderNumber: order.orderNumber,
  };
  res.json({ order, cjForward });
}));

router.post('/orders/:id/reject', asyncHandler(async (req, res) => {
  const { reason } = z.object({ reason: z.string().max(500).optional() }).parse(req.body || {});
  const order = await prisma.order.update({
    where: { id: req.params.id },
    data: { status: 'REJECTED', adminNotes: reason || null },
  });
  res.json({ order });
}));

router.post('/orders/:id/ship', asyncHandler(async (req, res) => {
  const { trackingNumber, trackingCarrier } = z.object({
    trackingNumber: z.string().min(3).max(80),
    trackingCarrier: z.string().max(80).optional(),
  }).parse(req.body);

  const order = await prisma.order.update({
    where: { id: req.params.id },
    data: {
      status: 'SHIPPED',
      trackingNumber, trackingCarrier: trackingCarrier || null,
      shippedAt: new Date(),
    },
    include: { items: true },
  });
  sendShippedNotice(order).catch(err => console.error('[admin.ship] email:', err.message));
  res.json({ order });
}));

router.post('/orders/:id/deliver', asyncHandler(async (req, res) => {
  const order = await prisma.order.update({
    where: { id: req.params.id },
    data: { status: 'DELIVERED', deliveredAt: new Date() },
  });
  res.json({ order });
}));

// -----------------------------------------------------------------------------
// AFFILIATES
// -----------------------------------------------------------------------------
router.get('/affiliates', asyncHandler(async (_req, res) => {
  const items = await prisma.affiliate.findMany({
    include: { user: { select: { email: true, displayName: true, username: true, role: true } } },
    orderBy: { totalEarned: 'desc' },
  });
  res.json({ items });
}));

router.put('/affiliates/:id', asyncHandler(async (req, res) => {
  const data = z.object({
    level: z.enum(['BRONZE','SILVER','GOLD','PLATINUM','DIAMOND']).optional(),
    type: z.enum(['REGULAR','INFLUENCER']).optional(),
    status: z.enum(['ACTIVE','SUSPENDED','PENDING']).optional(),
    commissionRate: z.number().min(0).max(90).nullable().optional(),
    promoCodeLocked: z.boolean().optional(),
  }).parse(req.body);
  const updated = await prisma.affiliate.update({ where: { id: req.params.id }, data });
  res.json({ affiliate: updated });
}));

router.get('/withdrawals', asyncHandler(async (_req, res) => {
  const items = await prisma.withdrawal.findMany({
    orderBy: { createdAt: 'desc' }, take: 200,
    include: { affiliate: { include: { user: { select: { email: true, displayName: true } } } } },
  });
  res.json({ items });
}));

router.post('/withdrawals/:id/status', asyncHandler(async (req, res) => {
  const { status, adminNote } = z.object({
    status: z.enum(['APPROVED','PAID','REJECTED']),
    adminNote: z.string().max(500).optional(),
  }).parse(req.body);
  const w = await prisma.withdrawal.findUnique({ where: { id: req.params.id } });
  if (!w) return res.status(404).json({ error: 'Not found' });

  // On REJECT, refund the reserved balance
  if (status === 'REJECTED' && w.status !== 'REJECTED') {
    await prisma.affiliate.update({
      where: { id: w.affiliateId },
      data: { balance: { increment: w.amount } },
    });
  }
  const updated = await prisma.withdrawal.update({
    where: { id: w.id }, data: { status, adminNote: adminNote || null },
  });
  res.json({ withdrawal: updated });
}));

// -----------------------------------------------------------------------------
// FEEDBACK
// -----------------------------------------------------------------------------
router.get('/feedback', asyncHandler(async (req, res) => {
  const { status } = req.query;
  const items = await prisma.feedback.findMany({
    where: status ? { status } : {},
    orderBy: { createdAt: 'desc' }, take: 200,
    include: { user: { select: { email: true, displayName: true } } },
  });
  res.json({ items });
}));

router.post('/feedback/:id/review', asyncHandler(async (req, res) => {
  const { level, status, adminNote, generateCoupon, couponValue, couponType } = z.object({
    level: z.enum(['UNSET','MICRO','MACRO']),
    status: z.enum(['REVIEWED','ACCEPTED','REJECTED']),
    adminNote: z.string().max(2000).optional(),
    generateCoupon: z.boolean().optional(),
    couponValue: z.number().positive().optional(),
    couponType: z.enum(['PERCENT','FIXED']).optional(),
  }).parse(req.body);

  const fb = await prisma.feedback.findUnique({ where: { id: req.params.id } });
  if (!fb) return res.status(404).json({ error: 'Not found' });

  let couponId = null;
  // MACRO auto-triggers a coupon reward unless the admin opts out
  if ((level === 'MACRO' || generateCoupon) && (fb.userId || fb.guestEmail)) {
    const code = await generateUniqueCouponCode('MACRO');
    const value = couponValue || (level === 'MACRO' ? 25 : 10);
    const type = couponType || 'PERCENT';
    const coupon = await prisma.coupon.create({
      data: {
        code, type, value,
        ownerUserId: fb.userId,
        reason: `Reward for feedback #${fb.id}`,
        maxUses: 1,
      },
    });
    couponId = coupon.id;

    // Email + in-app notify (best-effort)
    const email = fb.userId
      ? (await prisma.user.findUnique({ where: { id: fb.userId } }))?.email
      : fb.guestEmail;
    if (email) {
      sendCouponEmail(email, coupon, 'Your feedback made Fiad Shop better!').catch(() => {});
    }
    if (fb.userId) {
      await prisma.notification.create({
        data: {
          userId: fb.userId,
          title: 'You earned a coupon!',
          body: `Use code ${code} for ${type === 'PERCENT' ? value + '%' : '$' + value} off.`,
          link: '/products.html',
        },
      });
    }
  }

  const updated = await prisma.feedback.update({
    where: { id: fb.id },
    data: { level, status, adminNote: adminNote || null, couponId },
  });
  res.json({ feedback: updated, couponId });
}));

// -----------------------------------------------------------------------------
// AI KNOWLEDGE
// -----------------------------------------------------------------------------
const kbSchema = z.object({
  category: z.string().min(1).max(80),
  question: z.string().min(3).max(1000),
  answer: z.string().min(3).max(5000),
  keywords: z.array(z.string().min(1).max(40)).default([]),
  isActive: z.boolean().default(true),
  priority: z.number().int().min(0).max(100).default(0),
});

router.get('/ai-knowledge', asyncHandler(async (_req, res) => {
  const items = await prisma.aIKnowledge.findMany({ orderBy: { updatedAt: 'desc' } });
  res.json({ items });
}));

router.post('/ai-knowledge', asyncHandler(async (req, res) => {
  const data = kbSchema.parse(req.body);
  const item = await prisma.aIKnowledge.create({ data });
  res.status(201).json({ item });
}));

router.put('/ai-knowledge/:id', asyncHandler(async (req, res) => {
  const data = kbSchema.partial().parse(req.body);
  const item = await prisma.aIKnowledge.update({ where: { id: req.params.id }, data });
  res.json({ item });
}));

router.delete('/ai-knowledge/:id', asyncHandler(async (req, res) => {
  await prisma.aIKnowledge.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
}));

// -----------------------------------------------------------------------------
// EMAIL PROVIDERS
// -----------------------------------------------------------------------------
const emailProviderSchema = z.object({
  name: z.string().min(1).max(60),
  kind: z.enum(['BREVO','SENDPULSE','SMTP']),
  host: z.string().optional().nullable(),
  port: z.number().int().optional().nullable(),
  secure: z.boolean().default(true),
  authUser: z.string().optional().nullable(),
  authPass: z.string().optional().nullable(),
  apiKey: z.string().optional().nullable(),
  apiSecret: z.string().optional().nullable(),
  fromEmail: z.string().email().default('support@fiad.shop'),
  fromName: z.string().default('Fiad Shop'),
  priority: z.number().int().default(100),
  isActive: z.boolean().default(true),
});

router.get('/email-providers', asyncHandler(async (_req, res) => {
  const items = await prisma.emailProvider.findMany({ orderBy: { priority: 'asc' } });
  // Mask secrets for display
  items.forEach(p => {
    if (p.apiKey) p.apiKey = maskSecret(p.apiKey);
    if (p.apiSecret) p.apiSecret = maskSecret(p.apiSecret);
    if (p.authPass) p.authPass = maskSecret(p.authPass);
  });
  res.json({ items });
}));

router.post('/email-providers', asyncHandler(async (req, res) => {
  const data = emailProviderSchema.parse(req.body);
  const item = await prisma.emailProvider.create({ data });
  res.status(201).json({ item });
}));

router.put('/email-providers/:id', asyncHandler(async (req, res) => {
  const data = emailProviderSchema.partial().parse(req.body);
  // Empty-string secrets shouldn't overwrite existing ones
  ['apiKey','apiSecret','authPass'].forEach(k => { if (data[k] === '') delete data[k]; });
  const item = await prisma.emailProvider.update({ where: { id: req.params.id }, data });
  res.json({ item });
}));

router.delete('/email-providers/:id', asyncHandler(async (req, res) => {
  await prisma.emailProvider.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
}));

function maskSecret(s) {
  if (!s || s.length < 8) return '••••';
  return s.slice(0, 4) + '••••' + s.slice(-4);
}

// -----------------------------------------------------------------------------
// SUPPORT SETTINGS
// -----------------------------------------------------------------------------
router.get('/support-settings', asyncHandler(async (_req, res) => {
  let s = await prisma.supportSettings.findFirst();
  if (!s) s = await prisma.supportSettings.create({ data: {} });
  res.json({ settings: s });
}));

router.put('/support-settings', asyncHandler(async (req, res) => {
  const data = z.object({
    isLiveEnabled: z.boolean().optional(),
    offlineMessage: z.string().max(500).optional(),
  }).parse(req.body);
  let s = await prisma.supportSettings.findFirst();
  if (!s) {
    s = await prisma.supportSettings.create({ data });
  } else {
    s = await prisma.supportSettings.update({ where: { id: s.id }, data });
  }
  res.json({ settings: s });
}));

// -----------------------------------------------------------------------------
// HOMEPAGE FEATURED PRODUCTS
// -----------------------------------------------------------------------------
router.get('/settings/homepage', asyncHandler(async (_req, res) => {
  const s = await prisma.setting.findUnique({ where: { key: 'homepage_product_ids' } });
  res.json({ ids: Array.isArray(s?.value) ? s.value : [] });
}));

router.put('/settings/homepage', asyncHandler(async (req, res) => {
  const { ids } = z.object({ ids: z.array(z.string()).max(50) }).parse(req.body);
  const s = await prisma.setting.upsert({
    where: { key: 'homepage_product_ids' },
    create: { key: 'homepage_product_ids', value: ids },
    update: { value: ids },
  });
  res.json({ ids: s.value });
}));

// -----------------------------------------------------------------------------
// USERS (basic list + role change)
// -----------------------------------------------------------------------------
router.get('/users', asyncHandler(async (_req, res) => {
  const items = await prisma.user.findMany({
    orderBy: { createdAt: 'desc' }, take: 500,
    select: {
      id: true, email: true, displayName: true, username: true, role: true,
      isVerified: true, twoFactorEnabled: true, createdAt: true,
    },
  });
  res.json({ items });
}));

router.put('/users/:id/role', requireRole('ADMIN'), asyncHandler(async (req, res) => {
  const { role } = z.object({ role: z.enum(['USER','AFFILIATE','MODERATOR','ADMIN']) }).parse(req.body);
  const u = await prisma.user.update({ where: { id: req.params.id }, data: { role } });
  res.json({ user: { id: u.id, role: u.role } });
}));

// Admin creates the first admin during setup (or promotes) via CLI seed script.

module.exports = router;
