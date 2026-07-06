/* ============================================================================
 * Fiad Shop — Auth helpers
 * Wraps common auth flows and refreshes `/auth/me` on load.
 * Exposes global window.FiadAuth.
 * ========================================================================== */

(function (global) {
  'use strict';

  const { api, toast } = global.FiadAPI;

  async function register(email, password, displayName) {
    return api.post('/auth/register', { email, password, displayName });
  }

  async function verifyOtp(email, otp) {
    const res = await api.post('/auth/verify-otp', { email, otp });
    if (res.token) {
      api.auth.setToken(res.token);
      api.auth.setUser(res.user);
    }
    return res;
  }

  async function resendOtp(email) {
    return api.post('/auth/resend-otp', { email });
  }

  async function login(email, password, twoFactorCode) {
    const res = await api.post('/auth/login', { email, password, twoFactorCode });
    if (res.requires2FA) return { requires2FA: true };
    if (res.token) {
      api.auth.setToken(res.token);
      api.auth.setUser(res.user);
    }
    return res;
  }

  async function forgotPassword(email) {
    return api.post('/auth/forgot-password', { email });
  }

  async function resetPassword(token, password) {
    return api.post('/auth/reset-password', { token, password });
  }

  function logout() {
    api.auth.clearAuth();
    toast('Logged out', 'info');
    setTimeout(() => { location.href = 'index.html'; }, 400);
  }

  async function refreshMe() {
    if (!api.auth.getToken()) return null;
    try {
      const { user, affiliate } = await api.get('/auth/me');
      api.auth.setUser(user);
      // Stash affiliate for menu logic
      try { localStorage.setItem('fiad_affiliate', JSON.stringify(affiliate || null)); } catch {}
      return { user, affiliate };
    } catch (e) {
      // 401 handled inside api client (clears token); other errors we ignore silently.
      return null;
    }
  }

  function getUser() { return api.auth.getUser(); }
  function getAffiliate() {
    try { return JSON.parse(localStorage.getItem('fiad_affiliate') || 'null'); }
    catch { return null; }
  }
  function isLoggedIn() { return !!api.auth.getToken() && !!getUser(); }
  function isAdmin() { return getUser()?.role === 'ADMIN' || getUser()?.role === 'MODERATOR'; }
  function isAffiliate() { return getUser()?.role === 'AFFILIATE' || !!getAffiliate(); }

  // Refresh on load (fire-and-forget) so nav can render an accurate menu.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { refreshMe(); });
  } else {
    refreshMe();
  }

  global.FiadAuth = {
    register, verifyOtp, resendOtp, login, logout,
    forgotPassword, resetPassword, refreshMe,
    getUser, getAffiliate, isLoggedIn, isAdmin, isAffiliate,
  };
})(window);
