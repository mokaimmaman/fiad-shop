// Email dispatch with failover.
// Priority order (lowest number wins):
//   1. DB providers (EmailProvider table, ordered by `priority`, `isActive=true`)
//   2. ENV Brevo (BREVO_API_KEY)
//   3. ENV Sendpulse (SENDPULSE_API_KEY + SENDPULSE_SECRET)
//
// Each attempt is tried in order; on failure we log and move to the next.

const axios = require('axios');
const nodemailer = require('nodemailer');
const prisma = require('./prisma');

// ---------------------------------------------------------------------------
// Sendpulse token cache (OAuth client_credentials, TTL ~1h)
// ---------------------------------------------------------------------------
let sendpulseToken = null;
let sendpulseTokenExpiresAt = 0;

async function getSendpulseToken(apiId, apiSecret) {
  const now = Date.now();
  if (sendpulseToken && now < sendpulseTokenExpiresAt - 60_000) {
    return sendpulseToken;
  }
  const resp = await axios.post('https://api.sendpulse.com/oauth/access_token', {
    grant_type: 'client_credentials',
    client_id: apiId,
    client_secret: apiSecret,
  }, { timeout: 10_000 });
  sendpulseToken = resp.data.access_token;
  sendpulseTokenExpiresAt = now + (resp.data.expires_in || 3600) * 1000;
  return sendpulseToken;
}

// ---------------------------------------------------------------------------
// Individual senders — each throws on failure so the caller can fall through.
// ---------------------------------------------------------------------------

async function sendViaBrevoApi({ apiKey, fromEmail, fromName, to, subject, html, text }) {
  const resp = await axios.post('https://api.brevo.com/v3/smtp/email', {
    sender: { name: fromName, email: fromEmail },
    to: [{ email: to }],
    subject,
    htmlContent: html,
    textContent: text,
  }, {
    headers: { 'api-key': apiKey, 'Content-Type': 'application/json', accept: 'application/json' },
    timeout: 15_000,
  });
  return { provider: 'BREVO', id: resp.data?.messageId || null };
}

async function sendViaSendpulseApi({ apiKey, apiSecret, fromEmail, fromName, to, subject, html, text }) {
  const token = await getSendpulseToken(apiKey, apiSecret);
  const payload = {
    email: {
      html: Buffer.from(html || `<p>${text || ''}</p>`).toString('base64'),
      text: text || '',
      subject,
      from: { name: fromName, email: fromEmail },
      to: [{ email: to }],
    },
  };
  const resp = await axios.post('https://api.sendpulse.com/smtp/emails', payload, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    timeout: 15_000,
  });
  return { provider: 'SENDPULSE', id: resp.data?.id || null };
}

async function sendViaSmtp({ host, port, secure, authUser, authPass, fromEmail, fromName, to, subject, html, text }) {
  const transporter = nodemailer.createTransport({
    host, port: Number(port), secure: !!secure,
    auth: { user: authUser, pass: authPass },
  });
  const info = await transporter.sendMail({
    from: `"${fromName}" <${fromEmail}>`,
    to, subject, text, html,
  });
  return { provider: 'SMTP', id: info.messageId };
}

// ---------------------------------------------------------------------------
// Build ordered attempt list
// ---------------------------------------------------------------------------

async function buildProviderChain() {
  const chain = [];

  // 1. DB-managed providers first (admin can add/reorder these)
  try {
    const dbProviders = await prisma.emailProvider.findMany({
      where: { isActive: true },
      orderBy: { priority: 'asc' },
    });
    for (const p of dbProviders) {
      chain.push({ source: 'DB', ...p });
    }
  } catch (e) {
    console.warn('[email] Could not read EmailProvider table:', e.message);
  }

  // 2. ENV Brevo fallback
  if (process.env.BREVO_API_KEY) {
    chain.push({
      source: 'ENV', kind: 'BREVO', name: 'Brevo (env)',
      apiKey: process.env.BREVO_API_KEY,
      fromEmail: process.env.FROM_EMAIL || 'support@fiad.shop',
      fromName: process.env.FROM_NAME || 'Fiad Shop',
      priority: 900,
    });
  }

  // 3. ENV Sendpulse fallback
  if (process.env.SENDPULSE_API_KEY && process.env.SENDPULSE_SECRET) {
    chain.push({
      source: 'ENV', kind: 'SENDPULSE', name: 'Sendpulse (env)',
      apiKey: process.env.SENDPULSE_API_KEY,
      apiSecret: process.env.SENDPULSE_SECRET,
      fromEmail: process.env.FROM_EMAIL || 'support@fiad.shop',
      fromName: process.env.FROM_NAME || 'Fiad Shop',
      priority: 901,
    });
  }

  return chain;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Send an email. Tries each configured provider in order until one succeeds.
 * @returns {Promise<{provider:string,id:string|null}>}
 * @throws  If every provider fails.
 */
async function sendEmail({ to, subject, html, text }) {
  if (!to || !subject) throw new Error('sendEmail: `to` and `subject` are required');
  const chain = await buildProviderChain();
  if (chain.length === 0) throw new Error('No email providers configured');

  const errors = [];
  for (const p of chain) {
    try {
      const args = { ...p, to, subject, html, text };
      let result;
      switch (p.kind) {
        case 'BREVO':     result = await sendViaBrevoApi(args); break;
        case 'SENDPULSE': result = await sendViaSendpulseApi(args); break;
        case 'SMTP':      result = await sendViaSmtp(args); break;
        default:          throw new Error(`Unknown provider kind: ${p.kind}`);
      }
      console.log(`[email] sent via ${p.name} (${p.kind}) -> ${to}`);
      return result;
    } catch (err) {
      const msg = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      console.warn(`[email] provider ${p.name} failed: ${msg}`);
      errors.push({ provider: p.name, error: msg });
    }
  }

  const finalErr = new Error(`All email providers failed: ${JSON.stringify(errors)}`);
  finalErr.publicMessage = 'Unable to send email at this time.';
  throw finalErr;
}

// Convenient templated senders --------------------------------------------------

function baseTemplate(title, bodyHtml) {
  return `<!doctype html><html><body style="font-family:Inter,Arial,sans-serif;background:#f7f7f8;padding:24px;color:#111">
    <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;border:1px solid #eee">
      <div style="font-weight:700;font-size:20px;margin-bottom:16px">
        <span style="color:#f97316">FIAD</span> <span>SHOP</span>
      </div>
      <h1 style="font-size:18px;margin:0 0 12px">${title}</h1>
      <div style="font-size:14px;line-height:1.6;color:#333">${bodyHtml}</div>
      <hr style="border:none;border-top:1px solid #eee;margin:24px 0"/>
      <div style="font-size:12px;color:#888">Fiad Shop • support@fiad.shop</div>
    </div>
  </body></html>`;
}

async function sendOtpEmail(to, otp) {
  return sendEmail({
    to,
    subject: 'Your Fiad Shop verification code',
    html: baseTemplate('Verify your email',
      `<p>Use the code below to verify your Fiad Shop account. It expires in 5 minutes.</p>
       <div style="font-size:28px;font-weight:700;letter-spacing:6px;background:#fff7ed;color:#c2410c;padding:16px;text-align:center;border-radius:8px;margin:16px 0">${otp}</div>
       <p style="color:#666">If you didn't request this, ignore this email.</p>`),
    text: `Your Fiad Shop verification code is ${otp}. It expires in 5 minutes.`,
  });
}

async function sendPasswordResetEmail(to, resetLink) {
  return sendEmail({
    to,
    subject: 'Reset your Fiad Shop password',
    html: baseTemplate('Reset your password',
      `<p>Click the link below to reset your password. Link expires in 30 minutes.</p>
       <p><a href="${resetLink}" style="background:#f97316;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;display:inline-block">Reset password</a></p>
       <p style="color:#666">Or copy this URL: ${resetLink}</p>`),
    text: `Reset your Fiad Shop password: ${resetLink}`,
  });
}

async function sendOrderConfirmationEmail(to, order, trackingUrl) {
  const itemsHtml = order.items.map(i =>
    `<tr><td style="padding:6px 0">${i.name} × ${i.quantity}</td><td style="text-align:right">$${Number(i.lineTotal).toFixed(2)}</td></tr>`
  ).join('');
  return sendEmail({
    to,
    subject: `Order confirmed — ${order.orderNumber}`,
    html: baseTemplate('Thanks for your order!',
      `<p>Your order <b>${order.orderNumber}</b> is confirmed.</p>
       <table style="width:100%;border-collapse:collapse;margin:12px 0;font-size:14px">${itemsHtml}
         <tr><td style="padding:8px 0;border-top:1px solid #eee"><b>Total</b></td>
             <td style="text-align:right;border-top:1px solid #eee"><b>$${Number(order.total).toFixed(2)}</b></td></tr>
       </table>
       <p><a href="${trackingUrl}" style="background:#f97316;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;display:inline-block">Track your order</a></p>`),
    text: `Order ${order.orderNumber} confirmed. Track it at ${trackingUrl}`,
  });
}

async function sendShippedEmail(to, order, trackingUrl) {
  return sendEmail({
    to,
    subject: `Your order has shipped — ${order.orderNumber}`,
    html: baseTemplate('Your order is on the way',
      `<p>Order <b>${order.orderNumber}</b> has shipped.</p>
       ${order.trackingNumber ? `<p>Tracking #: <b>${order.trackingNumber}</b> (${order.trackingCarrier || 'carrier'})</p>` : ''}
       <p><a href="${trackingUrl}" style="background:#f97316;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;display:inline-block">Track shipment</a></p>`),
    text: `Order ${order.orderNumber} shipped. Track at ${trackingUrl}`,
  });
}

async function sendCouponEmail(to, coupon, reason) {
  return sendEmail({
    to,
    subject: `You've received a Fiad Shop coupon 🎁`,
    html: baseTemplate('A coupon just for you',
      `<p>${reason || 'Thanks for helping improve Fiad Shop!'}</p>
       <div style="font-size:22px;font-weight:700;letter-spacing:3px;background:#fff7ed;color:#c2410c;padding:16px;text-align:center;border-radius:8px;margin:16px 0">${coupon.code}</div>
       <p>Value: <b>${coupon.type === 'PERCENT' ? `${coupon.value}%` : `$${coupon.value}`}</b> off</p>`),
  });
}

module.exports = {
  sendEmail,
  sendOtpEmail,
  sendPasswordResetEmail,
  sendOrderConfirmationEmail,
  sendShippedEmail,
  sendCouponEmail,
};
