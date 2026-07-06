// AI chat endpoint.
// Strategy:
//   1. Search AIKnowledge for a keyword match. If confidence high, answer from KB.
//   2. Otherwise, call Mistral.
//   3. Log every Q/A to AIChatLog for future KB curation.

const express = require('express');
const { z } = require('zod');
const prisma = require('../lib/prisma');
const { chat } = require('../lib/mistral');
const { optionalAuth } = require('../middleware/auth');
const { aiLimiter } = require('../middleware/rateLimit');
const asyncHandler = require('../lib/asyncHandler');

const router = express.Router();

const chatSchema = z.object({
  sessionId: z.string().min(3).max(80),
  message: z.string().min(1).max(2000),
  history: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string().max(4000),
  })).max(20).optional(),
});

// Very small "search": tokenise the message, count keyword overlaps per KB entry.
async function searchKB(message) {
  const tokens = message
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2);
  if (tokens.length === 0) return null;

  const entries = await prisma.aIKnowledge.findMany({ where: { isActive: true } });
  let best = null;
  for (const e of entries) {
    const kws = Array.isArray(e.keywords) ? e.keywords.map(k => String(k).toLowerCase()) : [];
    const q = String(e.question).toLowerCase();
    let score = 0;
    for (const t of tokens) {
      if (kws.includes(t)) score += 3;
      if (q.includes(t)) score += 1;
    }
    score += (e.priority || 0);
    if (!best || score > best.score) best = { entry: e, score };
  }
  // Threshold: at least 3 (i.e. one keyword hit, or ~3 question overlaps).
  return best && best.score >= 3 ? best.entry : null;
}

router.post('/chat', optionalAuth, aiLimiter, asyncHandler(async (req, res) => {
  const { sessionId, message, history } = chatSchema.parse(req.body);

  // 1. Try KB
  const kb = await searchKB(message);
  if (kb) {
    await prisma.aIChatLog.create({
      data: {
        sessionId, userId: req.user?.id || null,
        question: message, answer: kb.answer, source: 'KB',
      },
    });
    return res.json({ answer: kb.answer, source: 'KB', kbId: kb.id });
  }

  // 2. Fall through to Mistral
  try {
    const { answer } = await chat(message, history || []);
    await prisma.aIChatLog.create({
      data: {
        sessionId, userId: req.user?.id || null,
        question: message, answer, source: 'MISTRAL',
      },
    });
    return res.json({ answer, source: 'MISTRAL' });
  } catch (err) {
    console.error('[ai.chat] Mistral failed:', err.message);
    return res.status(503).json({
      error: 'AI is temporarily unavailable. Please try again in a moment or contact support@fiad.shop.',
    });
  }
}));

// Public KB browse (for a "Common Questions" section)
router.get('/kb', asyncHandler(async (req, res) => {
  const { category } = req.query;
  const items = await prisma.aIKnowledge.findMany({
    where: { isActive: true, ...(category ? { category } : {}) },
    orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
    take: 50,
    select: { id: true, category: true, question: true, answer: true },
  });
  res.json({ items });
}));

module.exports = router;
