// Payment endpoints — NOWPayments invoice creation is triggered on order creation.
// This module exposes:
//   POST /api/payment/webhook  — NOWPayments IPN callback (raw body, HMAC verified)
//   GET  /api/payment/status/:invoiceId — optional status polling

const express = require('express');
const prisma = require('../lib/prisma');
const { verifyIpnSignature, getPaymentStatus } = require('../lib/nowpayments');
const { sendConfirmation } = require('../controllers/orderController');
const asyncHandler = require('../lib/asyncHandler');

const router = express.Router();

// Note: express.raw is applied for THIS path in src/index.js (before json parser).
router.post('/webhook', asyncHandler(async (req, res) => {
  const sig = req.headers['x-nowpayments-sig'];
  const raw = req.body; // Buffer

  if (!verifyIpnSignature(raw, sig)) {
    console.warn('[payment.webhook] signature invalid');
    return res.status(400).json({ error: 'Invalid signature' });
  }

  let payload;
  try { payload = JSON.parse(raw.toString('utf8')); }
  catch { return res.status(400).json({ error: 'Bad JSON' }); }

  const {
    order_id: orderNumber,
    payment_status: status,
    payment_id: paymentId,
    price_amount: priceAmount,
  } = payload;

  const order = await prisma.order.findUnique({
    where: { orderNumber },
    include: { items: true },
  });
  if (!order) {
    console.warn(`[payment.webhook] no order for ${orderNumber}`);
    return res.status(200).json({ ok: true }); // ack anyway to stop retries
  }

  const updateData = { paymentStatus: status };
  if (paymentId && !order.paymentInvoiceId) updateData.paymentInvoiceId = String(paymentId);

  if (['finished', 'confirmed'].includes(status)) {
    updateData.status = 'PAID';
    updateData.paidAt = new Date();
  } else if (['failed', 'expired'].includes(status)) {
    updateData.status = 'CANCELLED';
  }

  const updated = await prisma.order.update({
    where: { id: order.id },
    data: updateData,
    include: { items: true },
  });

  if (updated.status === 'PAID' && order.status !== 'PAID') {
    // Fire confirmation email (best-effort)
    sendConfirmation(updated).catch(err =>
      console.error('[payment.webhook] confirmation email failed:', err.message)
    );

    // Credit affiliate commission when applicable
    if (updated.affiliateId) {
      const commission = await computeCommission(updated);
      if (commission > 0) {
        await prisma.affiliate.update({
          where: { id: updated.affiliateId },
          data: {
            totalSales: { increment: 1 },
            totalEarned: { increment: commission },
            balance: { increment: commission },
          },
        });
      }
    }
  }

  res.status(200).json({ ok: true });
}));

router.get('/status/:invoiceId', asyncHandler(async (req, res) => {
  const data = await getPaymentStatus(req.params.invoiceId);
  res.json(data);
}));

async function computeCommission(order) {
  const items = await prisma.orderItem.findMany({
    where: { orderId: order.id },
    include: { product: true },
  });
  const aff = await prisma.affiliate.findUnique({ where: { id: order.affiliateId } });

  // If this was a discount link, the affiliate only keeps `affiliateKeepPercent`.
  let discountLink = null;
  if (order.promoCode) {
    discountLink = await prisma.discountLink.findUnique({ where: { code: order.promoCode } });
  }

  let commission = 0;
  for (const it of items) {
    const productPct = Number(it.product.affiliateCommission || 0);
    const overridePct = aff.commissionRate ? Number(aff.commissionRate) : null;
    const basePct = overridePct != null ? overridePct : productPct;
    const effectivePct = discountLink ? Number(discountLink.affiliateKeepPercent) : basePct;
    commission += Number(it.lineTotal) * (effectivePct / 100);
  }
  return Math.round(commission * 100) / 100;
}

module.exports = router;
