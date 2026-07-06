// CJ Dropshipping API client (minimal — auth + tracking lookup).
// The order forwarding itself is manual per spec, but we can query tracking.

const axios = require('axios');

const BASE = process.env.CJ_API_BASE || 'https://developers.cjdropshipping.com/api2.0/v1';

let cjToken = null;
let cjTokenExpiresAt = 0;

async function getToken() {
  const now = Date.now();
  if (cjToken && now < cjTokenExpiresAt - 60_000) return cjToken;
  if (!process.env.CJ_API_KEY) throw new Error('CJ_API_KEY not configured');

  // Some CJ integrations use email+apiKey; the field is often "password".
  const resp = await axios.post(`${BASE}/authentication/getAccessToken`, {
    email: process.env.CJ_EMAIL || 'api@fiad.shop',
    password: process.env.CJ_API_KEY,
  }, { timeout: 15_000 });
  cjToken = resp.data?.data?.accessToken || null;
  cjTokenExpiresAt = now + 12 * 60 * 60 * 1000; // 12h
  return cjToken;
}

async function getTracking(trackNumber) {
  const token = await getToken();
  const { data } = await axios.get(`${BASE}/logistic/trackInfo`, {
    params: { trackNumber },
    headers: { 'CJ-Access-Token': token },
    timeout: 15_000,
  });
  return data?.data || null;
}

module.exports = { getToken, getTracking };
