/* ============================================================================
 * Fiad Shop — API client
 * ----------------------------------------------------------------------------
 * A tiny fetch wrapper used by every page. Handles:
 *   - Base URL config (auto-detects local vs prod)
 *   - JWT injection from localStorage
 *   - JSON serialization
 *   - Unified error surface  → thrown as `ApiError` with { status, data }
 *   - Simple toast helper (used everywhere)
 *
 * Usage:
 *   import { api, toast } from './js/api.js';  // OR global window.FiadAPI
 *   const { items } = await api.get('/products');
 *   const { token } = await api.post('/auth/login', { email, password });
 *
 * Config override (put this BEFORE api.js in HTML to point at your own backend):
 *   <script>window.FIAD_CONFIG = { API_BASE: 'https://my-api.vercel.app/api' };</script>
 *   <script src="js/api.js"></script>
 * ========================================================================== */

(function (global) {
  'use strict';

  // ---- Config -------------------------------------------------------------
  const userCfg = global.FIAD_CONFIG || {};
  const isLocal =
    location.hostname === 'localhost' ||
    location.hostname === '127.0.0.1' ||
    location.hostname === '';

  const API_BASE =
    userCfg.API_BASE ||
    (isLocal ? 'http://localhost:4000/api' : '/api');   // '/api' expects same-origin rewrite

  const TOKEN_KEY = 'fiad_token';
  const USER_KEY  = 'fiad_user';

  // ---- Errors -------------------------------------------------------------
  class ApiError extends Error {
    constructor(message, status, data) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.data = data;
    }
  }

  // ---- Token helpers ------------------------------------------------------
  function getToken() {
    try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
  }
  function setToken(t) {
    try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); }
    catch {}
  }
  function getUser() {
    try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch { return null; }
  }
  function setUser(u) {
    try { u ? localStorage.setItem(USER_KEY, JSON.stringify(u)) : localStorage.removeItem(USER_KEY); }
    catch {}
  }
  function clearAuth() { setToken(null); setUser(null); }

  // ---- Core fetch ---------------------------------------------------------
  async function request(method, path, body, opts = {}) {
    const url = path.startsWith('http') ? path : API_BASE + path;
    const headers = {
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.headers || {}),
    };
    const token = getToken();
    if (token && !headers.Authorization) headers.Authorization = 'Bearer ' + token;

    let res;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        credentials: opts.credentials || 'omit',
        signal: opts.signal,
      });
    } catch (netErr) {
      throw new ApiError('Network error — check your connection.', 0, { cause: netErr.message });
    }

    let data = null;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      try { data = await res.json(); } catch { data = null; }
    } else {
      try { data = await res.text(); } catch { data = null; }
    }

    if (!res.ok) {
      const msg = (data && data.error) || res.statusText || `HTTP ${res.status}`;
      // Token expired / invalid → wipe and let UI redirect if it wants.
      if (res.status === 401 && token) clearAuth();
      throw new ApiError(msg, res.status, data);
    }
    return data;
  }

  const api = {
    get:    (p, opts)     => request('GET',    p, null, opts),
    post:   (p, b, opts)  => request('POST',   p, b || {}, opts),
    put:    (p, b, opts)  => request('PUT',    p, b || {}, opts),
    del:    (p, opts)     => request('DELETE', p, null, opts),
    base:   API_BASE,
    auth:   { getToken, setToken, getUser, setUser, clearAuth },
  };

  // ---- Toast --------------------------------------------------------------
  //
  // If the current page already defines a #toast-container, we use it.
  // Otherwise we inject one lazily so every page can call toast() safely.
  //
  function ensureToastContainer() {
    let c = document.getElementById('toast-container');
    if (c) return c;
    c = document.createElement('div');
    c.id = 'toast-container';
    c.className = 'fixed bottom-4 right-4 z-[9999] flex flex-col gap-2 items-end pointer-events-none';
    document.body.appendChild(c);
    return c;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function toast(message, type = 'success', ms = 3200) {
    const container = ensureToastContainer();
    const t = document.createElement('div');
    const icons = {
      success: 'fa-circle-check text-green-500',
      error:   'fa-circle-exclamation text-red-500',
      info:    'fa-circle-info text-cta-500',
      warn:    'fa-triangle-exclamation text-yellow-500',
    };
    const icon = icons[type] || icons.info;
    t.className =
      'pointer-events-auto bg-white dark:bg-zinc-900 border border-gray-200 dark:border-zinc-800 ' +
      'rounded-lg shadow-lg px-4 py-3 flex items-center gap-2 text-sm min-w-[220px] max-w-sm ' +
      'transition-all duration-300 opacity-0 translate-y-2';
    t.innerHTML = `<i class="fa-solid ${icon}"></i><span class="flex-1">${escapeHtml(message)}</span>`;
    container.appendChild(t);
    requestAnimationFrame(() => {
      t.classList.remove('opacity-0', 'translate-y-2');
    });
    setTimeout(() => {
      t.classList.add('opacity-0', 'translate-y-2');
      setTimeout(() => t.remove(), 300);
    }, ms);
  }

  // ---- Cart (localStorage-only per spec — cart stays local) ----------------
  const CART_KEY = 'fiad_cart';
  const cart = {
    get() {
      try { return JSON.parse(localStorage.getItem(CART_KEY) || '[]'); } catch { return []; }
    },
    save(items) { localStorage.setItem(CART_KEY, JSON.stringify(items)); this.emit(); },
    count() { return this.get().reduce((s, i) => s + (i.quantity || 1), 0); },
    subtotal() { return this.get().reduce((s, i) => s + (Number(i.price) || 0) * (i.quantity || 1), 0); },
    add(product, qty = 1, variant = null) {
      const items = this.get();
      const key = product.id + '|' + JSON.stringify(variant || {});
      const found = items.find(i => (i._key || i.id) === key || i.id === product.id);
      if (found && JSON.stringify(found.variant || {}) === JSON.stringify(variant || {})) {
        found.quantity = (found.quantity || 1) + qty;
      } else {
        items.push({
          _key: key,
          id: product.id,
          sku: product.sku,
          name: product.name,
          price: Number(product.basePrice ?? product.price ?? 0),
          image: (product.images && product.images[0]) || product.image || '',
          variant,
          quantity: qty,
        });
      }
      this.save(items);
      toast(`${product.name} added to cart`, 'success');
    },
    remove(key) { this.save(this.get().filter(i => (i._key || i.id) !== key)); },
    updateQty(key, qty) {
      const items = this.get();
      const it = items.find(i => (i._key || i.id) === key);
      if (it) { it.quantity = Math.max(1, qty); this.save(items); }
    },
    clear() { this.save([]); },
    emit() {
      // Update every cart-count badge on the page + fire an event other JS can hook.
      const c = this.count();
      document.querySelectorAll('#cart-count, [data-cart-count]').forEach(el => {
        el.textContent = c;
        el.classList.toggle('hidden', c === 0);
      });
      document.dispatchEvent(new CustomEvent('fiad:cart-updated', { detail: { count: c } }));
    },
  };

  // Fire once on load so badges render immediately
  if (document.readyState !== 'loading') {
    setTimeout(() => cart.emit(), 0);
  } else {
    document.addEventListener('DOMContentLoaded', () => cart.emit());
  }

  // ---- Wishlist (localStorage) -------------------------------------------
  const WISH_KEY = 'fiad_wishlist';
  const wishlist = {
    get() { try { return JSON.parse(localStorage.getItem(WISH_KEY) || '[]'); } catch { return []; } },
    save(v) { localStorage.setItem(WISH_KEY, JSON.stringify(v)); this.emit(); },
    has(id) { return this.get().some(i => i.id === id); },
    toggle(product) {
      const items = this.get();
      const idx = items.findIndex(i => i.id === product.id);
      if (idx >= 0) { items.splice(idx, 1); toast('Removed from wishlist', 'info'); }
      else {
        items.push({
          id: product.id, name: product.name,
          price: Number(product.basePrice ?? product.price ?? 0),
          image: (product.images && product.images[0]) || product.image || '',
        });
        toast('Added to wishlist ❤', 'success');
      }
      this.save(items);
      return !idx || idx < 0;
    },
    remove(id) { this.save(this.get().filter(i => i.id !== id)); },
    clear() { this.save([]); },
    emit() {
      const c = this.get().length;
      document.querySelectorAll('#wishlist-count, [data-wishlist-count]').forEach(el => {
        el.textContent = c;
        el.classList.toggle('hidden', c === 0);
      });
    },
  };
  if (document.readyState !== 'loading') setTimeout(() => wishlist.emit(), 0);
  else document.addEventListener('DOMContentLoaded', () => wishlist.emit());

  // ---- Expose -------------------------------------------------------------
  global.FiadAPI = {
    api,
    ApiError,
    toast,
    escapeHtml,
    cart,
    wishlist,
    config: { API_BASE, TOKEN_KEY, USER_KEY },
  };
})(window);
