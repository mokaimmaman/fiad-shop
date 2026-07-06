// Feedback / "Earn With Us" — users submit suggestions and bug reports.
// Admin reviews and can promote to MACRO (which triggers a coupon reward).

const express = require('express');
const { z } = require('zod');
const prisma = require('../lib/prisma');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const asyncHandler = require('../lib/asyncHandler');

const router = express.Router();

const submitSchema = z.object({
  type: z.enum(['SUGGESTION', 'SOFTWARE_BUG', 'SECURITY_BUG']),
  levelRequested: z.enum(['MICRO', 'MACRO']).optional(),
  title: z.string().min(3).max(160),
  description: z.string().min(10).max(5000),
  imageUrl: z.string().url().max(600).optional(),
  guestEmail: z.string().email().optional(),
});

router.post('/', optionalAuth, asyncHandler(async (req, res) => {
  const data = submitSchema.parse(req.body);
  if (!req.user && !data.guestEmail) {
    return res.status(400).json({ error: 'Login or provide an email address.' });
  }
  const fb = await prisma.feedback.create({
    data: {
      userId: req.user?.id || null,
      guestEmail: req.user ? null : data.guestEmail,
      type: data.type,
      levelRequested: data.levelRequested || 'UNSET',
      title: data.title,
      description: data.description,
      imageUrl: data.imageUrl || null,
    },
  });
  res.status(201).json({ feedback: fb, message: 'Thanks — our team will review your submission.' });
}));

router.get('/mine', requireAuth, asyncHandler(async (req, res) => {
  const items = await prisma.feedback.findMany({
    where: { userId: req.user.id },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  res.json({ items });
}));

module.exports = router;
