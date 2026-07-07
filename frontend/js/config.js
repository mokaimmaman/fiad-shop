/* ============================================================================
 * Fiad Shop — Frontend runtime config
 * ----------------------------------------------------------------------------
 * Loaded BEFORE api.js. Point API_BASE at your deployed backend so the
 * GitHub Pages site can talk to the Vercel API.
 *
 * For LOCAL dev, leave API_BASE empty (or "http://localhost:4000/api") —
 * api.js auto-detects localhost and points there.
 *
 * For PRODUCTION, replace the URL below with your real Vercel domain.
 * ========================================================================== */

window.FIAD_CONFIG = {
  // Full base URL of your backend, including "/api". No trailing slash.
  // Example: 'https://fiad-shop-backend.vercel.app/api'
  API_BASE: 'https://fiad-shop.vercel.app/api', // ← set this before deploying to GitHub Pages
};
