// Public product APIs (list, detail, search). Admin CRUD lives in admin.js.

const express = require('express');
const prisma = require('../lib/prisma');
const asyncHandler = require('../lib/asyncHandler');

const router = express.Router();

router.get('/', asyncHandler(async (req, res) => {
  const { category, q, sort, limit = 24, offset = 0 } = req.query;
  const where = { isActive: true };
  if (category && category !== 'all') where.category = category;
  if (q) {
    where.OR = [
      { name: { contains: q, mode: 'insensitive' } },
      { description: { contains: q, mode: 'insensitive' } },
    ];
  }
  const orderBy =
    sort === 'price-asc'  ? { basePrice: 'asc' } :
    sort === 'price-desc' ? { basePrice: 'desc' } :
    sort === 'newest'     ? { createdAt: 'desc' } :
                            { createdAt: 'desc' };

  const [items, total] = await Promise.all([
    prisma.product.findMany({
      where, orderBy, take: Math.min(Number(limit), 100), skip: Number(offset),
      include: { variants: true },
    }),
    prisma.product.count({ where }),
  ]);
  res.json({ items, total, limit: Number(limit), offset: Number(offset) });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const p = await prisma.product.findUnique({
    where: { id: req.params.id },
    include: {
      variants: true,
      packageItems: { include: { childProduct: true } },
    },
  });
  if (!p || !p.isActive) return res.status(404).json({ error: 'Product not found' });
  res.json({ product: p });
}));

router.get('/by-sku/:sku', asyncHandler(async (req, res) => {
  const p = await prisma.product.findUnique({
    where: { sku: req.params.sku },
    include: { variants: true },
  });
  if (!p || !p.isActive) return res.status(404).json({ error: 'Product not found' });
  res.json({ product: p });
}));

module.exports = router;
