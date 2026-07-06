// Public settings (homepage featured products, live-support toggle status, etc.)

const express = require('express');
const prisma = require('../lib/prisma');
const asyncHandler = require('../lib/asyncHandler');

const router = express.Router();

// Homepage featured products — Admin manages the ID list via /api/admin/settings/homepage.
router.get('/homepage', asyncHandler(async (_req, res) => {
  const setting = await prisma.setting.findUnique({ where: { key: 'homepage_product_ids' } });
  const ids = Array.isArray(setting?.value) ? setting.value : [];
  if (ids.length === 0) {
    // Fallback: newest 8 active products
    const items = await prisma.product.findMany({
      where: { isActive: true },
      orderBy: { createdAt: 'desc' },
      take: 8,
      include: { variants: true },
    });
    return res.json({ items });
  }
  const items = await prisma.product.findMany({
    where: { id: { in: ids }, isActive: true },
    include: { variants: true },
  });
  // Preserve admin's ordering
  const byId = Object.fromEntries(items.map(p => [p.id, p]));
  res.json({ items: ids.map(id => byId[id]).filter(Boolean) });
}));

// Support status (used by frontend to decide whether to show chat button)
router.get('/support-status', asyncHandler(async (_req, res) => {
  const s = await prisma.supportSettings.findFirst();
  res.json({
    isLiveEnabled: s?.isLiveEnabled || false,
    offlineMessage: s?.offlineMessage ||
      "Our team is currently offline. Please leave a message and we'll get back to you within 24 hours.",
  });
}));

// Categories list (derived from product data)
router.get('/categories', asyncHandler(async (_req, res) => {
  const groups = await prisma.product.groupBy({
    by: ['category'],
    where: { isActive: true },
    _count: { category: true },
  });
  res.json({
    categories: groups
      .map(g => ({ name: g.category, count: g._count.category }))
      .sort((a, b) => b.count - a.count),
  });
}));

module.exports = router;
