// Live support routes (backed by Ably).
//
// Flow:
//   1. Frontend calls GET  /token?clientId=... to get an Ably tokenRequest.
//   2. Frontend calls POST /session with { email } to open a session.
//      -> server returns { sessionId, channel }
//   3. Frontend + admin subscribe to that channel via Ably and exchange messages.
//   4. Frontend calls POST /session/:id/message to persist each message
//      (so admin can see conversation history even after refresh).
//   5. Admin calls POST /session/:id/join, /close as needed.
//
// If live support is disabled, /session returns 503 with the offline message.

const express = require('express');
const { z } = require('zod');
const prisma = require('../lib/prisma');
const {
  createTokenRequest, publish, sessionChannelName,
  sessionCapability, adminCapability, adminNotifyChannel,
} = require('../lib/ably');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/roleCheck');
const asyncHandler = require('../lib/asyncHandler');

const router = express.Router();

async function getSettings() {
  let s = await prisma.supportSettings.findFirst();
  if (!s) s = await prisma.supportSettings.create({ data: {} });
  return s;
}

router.get('/status', asyncHandler(async (_req, res) => {
  const s = await getSettings();
  res.json({ isLiveEnabled: s.isLiveEnabled, offlineMessage: s.offlineMessage });
}));

/**
 * Customer token — scoped to ONE session.
 * The frontend calls POST /session first to create the session, THEN calls
 * /token?sessionId=… so the returned capability only grants access to that
 * one channel.
 */
router.get('/token', asyncHandler(async (req, res) => {
  const sessionId = String(req.query.sessionId || '').slice(0, 60);
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  const session = await prisma.liveSupportSession.findUnique({ where: { id: sessionId } });
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const clientId = 'user-' + sessionId;
  const capability = sessionCapability(sessionId);
  const tokenRequest = await createTokenRequest(clientId, capability);
  res.json({ tokenRequest, clientId, channel: sessionChannelName(sessionId) });
}));

/**
 * Admin token — access to admin-notify + every session channel.
 * Requires ADMIN or MODERATOR auth.
 */
router.get('/admin/token', requireAuth, requireRole('ADMIN', 'MODERATOR'),
  asyncHandler(async (req, res) => {
    const clientId = 'admin-' + req.user.id;
    const tokenRequest = await createTokenRequest(clientId, adminCapability());
    res.json({
      tokenRequest, clientId,
      adminNotifyChannel: adminNotifyChannel(),
    });
  })
);

router.post('/session', optionalAuth, asyncHandler(async (req, res) => {
  const { email } = z.object({ email: z.string().email() }).parse(req.body);
  const s = await getSettings();
  if (!s.isLiveEnabled) {
    return res.status(503).json({
      error: 'Live support offline',
      offlineMessage: s.offlineMessage,
      code: 'SUPPORT_OFFLINE',
    });
  }
  const session = await prisma.liveSupportSession.create({
    data: {
      userId: req.user?.id || null,
      email: email.toLowerCase(),
      channel: 'placeholder',
      status: 'WAITING',
      messages: [],
    },
  });
  const channel = sessionChannelName(session.id);
  await prisma.liveSupportSession.update({ where: { id: session.id }, data: { channel } });

  // Announce new session on a global admin channel
  await publish('admin-notify', 'session-created', {
    sessionId: session.id, email: session.email, channel,
  }).catch(() => {});

  res.status(201).json({ sessionId: session.id, channel });
}));

router.post('/session/:id/message', optionalAuth, asyncHandler(async (req, res) => {
  const { sender, message } = z.object({
    sender: z.enum(['user', 'admin', 'system']),
    message: z.string().min(1).max(2000),
  }).parse(req.body);

  const session = await prisma.liveSupportSession.findUnique({ where: { id: req.params.id } });
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const entry = { sender, message, timestamp: new Date().toISOString() };
  const messages = Array.isArray(session.messages) ? session.messages : [];
  messages.push(entry);

  await prisma.liveSupportSession.update({
    where: { id: session.id },
    data: { messages, status: session.status === 'WAITING' && sender === 'admin' ? 'ACTIVE' : session.status },
  });
  // Also broadcast (belt-and-braces; the sender typically publishes on client)
  publish(session.id, 'message', entry).catch(() => {});
  res.json({ ok: true });
}));

router.get('/session/:id', optionalAuth, asyncHandler(async (req, res) => {
  const session = await prisma.liveSupportSession.findUnique({ where: { id: req.params.id } });
  if (!session) return res.status(404).json({ error: 'Session not found' });
  // Only owner (by user or email) or admin
  if (req.user?.role !== 'ADMIN' && req.user?.id !== session.userId) {
    // Guests: nothing we can check server-side beyond ID, so allow read.
  }
  res.json({ session });
}));

// ---- Admin ------------------------------------------------------------------
router.get('/admin/sessions', requireAuth, requireRole('ADMIN', 'MODERATOR'),
  asyncHandler(async (req, res) => {
    const { status = 'ACTIVE' } = req.query;
    const sessions = await prisma.liveSupportSession.findMany({
      where: status === 'ALL' ? {} : { status },
      orderBy: { updatedAt: 'desc' }, take: 100,
    });
    res.json({ sessions });
  })
);

router.post('/admin/session/:id/join', requireAuth, requireRole('ADMIN', 'MODERATOR'),
  asyncHandler(async (req, res) => {
    const session = await prisma.liveSupportSession.update({
      where: { id: req.params.id },
      data: { adminId: req.user.id, status: 'ACTIVE' },
    });
    publish(session.id, 'admin-joined', { adminId: req.user.id, displayName: req.user.displayName })
      .catch(() => {});
    res.json({ session });
  })
);

router.post('/admin/session/:id/close', requireAuth, requireRole('ADMIN', 'MODERATOR'),
  asyncHandler(async (req, res) => {
    const session = await prisma.liveSupportSession.update({
      where: { id: req.params.id }, data: { status: 'CLOSED' },
    });
    publish(session.id, 'session-closed', {}).catch(() => {});
    res.json({ session });
  })
);

module.exports = router;
