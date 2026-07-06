// NOWPayments client — invoice creation + IPN signature verification.

const axios = require('axios');
const crypto = require('crypto');

const BASE = 'https://api.nowpayments.io/v1';

function client() {
  return axios.create({
    baseURL: BASE,
    headers: {
      'x-api-key': process.env.NOWPAYMENTS_API_KEY,
      'Content-Type': 'application/json',
    },
    timeout: 15_000,
  });
}

/**
 * Create a hosted invoice. Returns { id, invoice_url, ... }.
 * @param {object} p
 * @param {string} p.orderId       Our internal order ID
 * @param {string} p.orderNumber   User-facing order #
 * @param {number} p.priceAmount   USD amount
 * @param {string} p.priceCurrency 'usd'
 * @param {string} p.successUrl
 * @param {string} p.cancelUrl
 * @param {string} p.ipnUrl        Webhook URL (our /api/payment/webhook)
 */
async function createInvoice(p) {
  const body = {
    price_amount: Number(p.priceAmount),
    price_currency: p.priceCurrency || 'usd',
    order_id: p.orderNumber,
    order_description: `Fiad Shop order ${p.orderNumber}`,
    ipn_callback_url: p.ipnUrl,
    success_url: p.successUrl,
    cancel_url: p.cancelUrl,
  };
  const { data } = await client().post('/invoice', body);
  return data;
}

/** Fetch a payment's current status. */
async function getPaymentStatus(paymentId) {
  const { data } = await client().get(`/payment/${paymentId}`);
  return data;
}

/**
 * Verify NOWPayments IPN signature.
 * Header: x-nowpayments-sig
 * Signature = HMAC-SHA512 of sorted-JSON body using NOWPAYMENTS_IPN_SECRET.
 */
function verifyIpnSignature(rawBody, signatureHeader) {
  const secret = process.env.NOWPAYMENTS_IPN_SECRET;
  if (!secret) {
    console.warn('[nowpayments] IPN secret not set — skipping verification');
    return true;
  }
  if (!signatureHeader) return false;

  // NOWPayments requires the JSON body's KEYS sorted alphabetically.
  let parsed;
  try {
    parsed = typeof rawBody === 'string' ? JSON.parse(rawBody) : JSON.parse(rawBody.toString('utf8'));
  } catch { return false; }
  const sorted = JSON.stringify(sortKeysDeep(parsed));
  const hmac = crypto.createHmac('sha512', secret).update(sorted).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(signatureHeader));
}

function sortKeysDeep(obj) {
  if (Array.isArray(obj)) return obj.map(sortKeysDeep);
  if (obj && typeof obj === 'object') {
    return Object.keys(obj).sort().reduce((acc, k) => {
      acc[k] = sortKeysDeep(obj[k]);
      return acc;
    }, {});
  }
  return obj;
}

module.exports = { createInvoice, getPaymentStatus, verifyIpnSignature };
