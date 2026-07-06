// Order lifecycle: create (guest or user), list, track, admin approve/ship.

const { z } = require('zod');
const prisma = require('../lib/prisma');
const { generateOrderNumber } = require('../utils/couponGenerator');
const { createInvoice } = require('../lib/nowpayments');
const { sendOrderConfirmationEmail, sendShippedEmail } = require('../lib/email');
const { getTracking } = require('../lib/cj');

// -----------------------------------------------------------------------------
// Schemas
// -----------------------------------------------------------------------------
const addressSchema = z.object({
  fullName: z.string().min(1).max(120),
  email: z.string().email(),
  phone: z.string().min(4).max(30),
  line1: z.string().min(1).max(200),
  line2: z.string().max(200).optional().nullable(),
  city: z.string().min(1).max(100),
  state: z.string().max(100).optional().nullable(),
  country: z.string().min(2).max(80),
  postalCode: z.string().min(1).max(30),
});

const itemSchema = z.object({
  productId: z.string(),
  quantity: z.number().int().min(1).max(99),
  variant: z.object({
    color: z.string().optional().nullable(),
    size: z.string().optional().nullable(),
    material: z.string().optional().nullable(),
  }).optional(),
});

const createOrderSchema = z.object({
  items: z.array(itemSchema).min(1).max(50),
  shippingAddress: addressSchema,
  promoCode: z.string().max(40).optional().nullable(),
  ref: z.string().max(40).optional().nullable(),   // affiliate promo code from URL
});

// -----------------------------------------------------------------------------
// Pricing engine
// -----------------------------------------------------------------------------

async function resolvePromo(promoCode, ref) {
  const code = (promoCode || ref || '').trim();
  if (!code) return { affiliate: null, coupon: null, discountLink: null };

  // Try coupon first
  const coupon = await prisma.coupon.findUnique({ where: { code } });
  if (coupon && coupon.isActive && (!coupon.expiresAt || coupon.expiresAt > new Date())
      && (!coupon.maxUses || coupon.uses < coupon.maxUses)) {
    return { coupon };
  }

  // Try affiliate discount link (partial-commission share)
  const dl = await prisma.discountLink.findUnique({
    where: { code },
    include: { affiliate: true },
  });
  if (dl && dl.isActive && (!dl.expiresAt || dl.expiresAt > new Date())
      && (!dl.maxUses || dl.uses < dl.maxUses)) {
    return { affiliate: dl.affiliate, discountLink: dl };
  }

  // Try raw affiliate promoCode (no discount, just attribution)
  const aff = await prisma.affiliate.findUnique({ where: { promoCode: code } });
  if (aff && aff.status === 'ACTIVE') {
    return { affiliate: aff };
  }

  return {};
}

function calcDiscount(subtotal, { coupon, discountLink }) {
  if (coupon) {
    if (coupon.type === 'PERCENT') return round2(subtotal * (Number(coupon.value) / 100));
    return Math.min(Number(coupon.value), subtotal);
  }
  if (discountLink) {
    return round2(subtotal * (Number(discountLink.discountPercent) / 100));
  }
  return 0;
}

function round2(n) { return Math.round(n * 100) / 100; }

// -----------------------------------------------------------------------------
// Create order
// -----------------------------------------------------------------------------
async function createOrder(req, res) {
  const data = createOrderSchema.parse(req.body);
  const userId = req.user?.id || null;

  // Load & validate products
  const productIds = data.items.map(i => i.productId);
  const products = await prisma.product.findMany({
    where: { id: { in: productIds }, isActive: true },
  });
  const byId = Object.fromEntries(products.map(p => [p.id, p]));
  for (const i of data.items) {
    if (!byId[i.productId]) {
      return res.status(400).json({ error: `Product not available: ${i.productId}` });
    }
  }

  const orderItems = data.items.map(i => {
    const p = byId[i.productId];
    const unitPrice = Number(p.basePrice);
    const lineTotal = round2(unitPrice * i.quantity);
    return {
      productId: p.id,
      variantJson: i.variant || null,
      sku: p.sku,
      name: p.name,
      unitPrice,
      quantity: i.quantity,
      lineTotal,
    };
  });

  const subtotal = round2(orderItems.reduce((s, i) => s + i.lineTotal, 0));
  const promo = await resolvePromo(data.promoCode, data.ref);
  const discountAmount = calcDiscount(subtotal, promo);
  const shippingAmount = 0; // flat/free for now
  const total = round2(subtotal - discountAmount + shippingAmount);

  const order = await prisma.order.create({
    data: {
      orderNumber: generateOrderNumber(),
      userId,
      guestEmail: userId ? null : data.shippingAddress.email,
      items: { create: orderItems },
      subtotal,
      discountAmount,
      shippingAmount,
      total,
      shippingAddress: data.shippingAddress,
      promoCode: data.promoCode || data.ref || null,
      affiliateId: promo.affiliate?.id || null,
      couponId: promo.coupon?.id || null,
      status: 'PENDING',
    },
    include: { items: true },
  });

  // Bump usage counters (best-effort)
  if (promo.coupon) {
    await prisma.coupon.update({ where: { id: promo.coupon.id }, data: { uses: { increment: 1 } } });
  }
  if (promo.discountLink) {
    await prisma.discountLink.update({ where: { id: promo.discountLink.id }, data: { uses: { increment: 1 } } });
  }

  // Create NOWPayments invoice (only if key configured; otherwise return raw order)
  let paymentUrl = null;
  if (process.env.NOWPAYMENTS_API_KEY) {
    try {
      const invoice = await createInvoice({
        orderId: order.id,
        orderNumber: order.orderNumber,
        priceAmount: total,
        priceCurrency: 'usd',
        successUrl: `${process.env.FRONTEND_URL}/order-confirmation.html?order=${order.orderNumber}`,
        cancelUrl: `${process.env.FRONTEND_URL}/checkout.html?cancelled=1`,
        ipnUrl: `${process.env.BACKEND_URL}/api/payment/webhook`,
      });
      paymentUrl = invoice.invoice_url;
      await prisma.order.update({
        where: { id: order.id },
        data: {
          paymentProvider: 'NOWPAYMENTS',
          paymentInvoiceId: String(invoice.id),
          paymentStatus: 'waiting',
        },
      });
    } catch (err) {
      console.error('[order.create] NOWPayments invoice failed:', err.message);
    }
  }

  return res.status(201).json({
    order: { id: order.id, orderNumber: order.orderNumber, total: order.total, status: order.status },
    paymentUrl,
  });
}

// -----------------------------------------------------------------------------
// My orders
// -----------------------------------------------------------------------------
async function myOrders(req, res) {
  const orders = await prisma.order.findMany({
    where: { userId: req.user.id },
    orderBy: { createdAt: 'desc' },
    include: { items: true },
    take: 100,
  });
  res.json({ orders });
}

// -----------------------------------------------------------------------------
// Track order (public: by orderNumber + optional email for guests)
// -----------------------------------------------------------------------------
async function trackOrder(req, res) {
  const { orderNumber } = req.params;
  const { email } = req.query;
  const order = await prisma.order.findUnique({
    where: { orderNumber },
    include: { items: true },
  });
  if (!order) return res.status(404).json({ error: 'Order not found' });

  // If order belongs to a user, only that user (or admin) can see it.
  if (order.userId) {
    if (!req.user || (req.user.id !== order.userId && req.user.role !== 'ADMIN')) {
      return res.status(403).json({ error: 'Access denied' });
    }
  } else {
    // Guest order — require matching email
    const guestEmail = (order.guestEmail || '').toLowerCase();
    if (!email || String(email).toLowerCase() !== guestEmail) {
      return res.status(403).json({ error: 'Email required to track guest order' });
    }
  }

  // Try live CJ tracking if we have a number
  let cjTracking = null;
  if (order.trackingNumber && process.env.CJ_API_KEY) {
    try { cjTracking = await getTracking(order.trackingNumber); }
    catch (e) { console.warn('[track] CJ lookup failed:', e.message); }
  }

  res.json({
    order: {
      orderNumber: order.orderNumber,
      status: order.status,
      total: order.total,
      trackingNumber: order.trackingNumber,
      trackingCarrier: order.trackingCarrier,
      shippedAt: order.shippedAt,
      deliveredAt: order.deliveredAt,
      items: order.items.map(i => ({ name: i.name, quantity: i.quantity, lineTotal: i.lineTotal })),
      createdAt: order.createdAt,
    },
    cjTracking,
  });
}

// -----------------------------------------------------------------------------
// Send order confirmation email (called from payment webhook success)
// -----------------------------------------------------------------------------
async function sendConfirmation(order) {
  const to = order.userId
    ? (await prisma.user.findUnique({ where: { id: order.userId } }))?.email
    : order.guestEmail;
  if (!to) return;
  const trackingUrl = `${process.env.FRONTEND_URL}/order-tracking.html?order=${order.orderNumber}` +
                      (order.userId ? '' : `&email=${encodeURIComponent(to)}`);
  await sendOrderConfirmationEmail(to, order, trackingUrl);
}

async function sendShippedNotice(order) {
  const to = order.userId
    ? (await prisma.user.findUnique({ where: { id: order.userId } }))?.email
    : order.guestEmail;
  if (!to) return;
  const trackingUrl = `${process.env.FRONTEND_URL}/order-tracking.html?order=${order.orderNumber}` +
                      (order.userId ? '' : `&email=${encodeURIComponent(to)}`);
  await sendShippedEmail(to, order, trackingUrl);
}

module.exports = {
  createOrder,
  myOrders,
  trackOrder,
  sendConfirmation,
  sendShippedNotice,
};
