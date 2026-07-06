/* ============================================================================
 * Fiad Shop — UI helpers
 *   - Logo component (SVG)  → <span data-fiad-logo></span>  OR  FiadUI.logoHTML()
 *   - 3-dot menu            → <div data-fiad-menu></div>   (role-aware)
 *   - Floating AI bot       → auto-mounted, links to ai.html
 *   - Live support widget   → shows only if backend reports isLiveEnabled
 *
 * Also upgrades the existing static "FIAD SHOP" text-logos in the nav/footer
 * to the new SVG logo without changing any surrounding markup.
 * ========================================================================== */

(function (global) {
  'use strict';

  const { api, toast, escapeHtml } = global.FiadAPI;

  // ==========================================================================
  //  LOGO
  //  ---------------------------------------------------------------------
  //  "FIAD" — always #FF6A00
  //  "SHOP" — currentColor  (Tailwind sets:  text-gray-900 dark:text-white)
  //  Font: Inter 800, letter-spacing -3px, size scales to container height.
  //  Uses viewBox so `height="…"` on the outer <span> controls actual pixel size.
  // ==========================================================================

  /**
   * Return the SVG logo markup at a given pixel height.
   * @param {number} heightPx  render height in px (width auto by aspect ratio)
   */
  function logoHTML(heightPx = 32) {
    // Aspect ratio of "FIADSHOP" at these settings ≈ 4.4 : 1
    const width = Math.round(heightPx * 4.4);
    return `
<span class="fiad-logo inline-flex items-center leading-none text-gray-900 dark:text-white align-middle" style="height:${heightPx}px" aria-label="Fiad Shop">
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 180" role="img"
       width="${width}" height="${heightPx}" style="display:block;overflow:visible">
    <text x="0" y="140"
          font-family="'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif"
          font-size="130" font-weight="800" letter-spacing="-3">
      <tspan fill="#FF6A00">FIAD</tspan><tspan fill="currentColor">SHOP</tspan>
    </text>
  </svg>
</span>`.trim();
  }

  /** Swap any element carrying [data-fiad-logo] for the SVG. Optional attr: data-size="28" */
  function mountLogos() {
    document.querySelectorAll('[data-fiad-logo]').forEach(el => {
      const size = Number(el.getAttribute('data-size')) || 32;
      el.outerHTML = logoHTML(size);
    });

    // ALSO auto-upgrade the legacy two-<span> pattern used in the existing HTML files:
    //   <a href="index.html" ...>
    //     <span class="text-cta-500 ...">FIAD</span>
    //     <span class="text-gray-900 ...">SHOP</span>
    //   </a>
    // We only swap when we recognise the pattern exactly, so we don't touch anything else.
    document.querySelectorAll('a[href$="index.html"], a[href="/"], a[href="./"]').forEach(a => {
      const spans = a.querySelectorAll(':scope > span');
      if (spans.length !== 2) return;
      const t1 = (spans[0].textContent || '').trim().toUpperCase();
      const t2 = (spans[1].textContent || '').trim().toUpperCase();
      if (t1 === 'FIAD' && t2 === 'SHOP') {
        // Preserve the anchor's classes but replace inner content.
        // Size hint: navbar logo ≈ 28-30px, footer/hero can be larger via attr.
        const size = Number(a.getAttribute('data-logo-size')) || 28;
        a.innerHTML = logoHTML(size);
      }
    });

    // Footer variant used in some pages: <span>FIAD</span>SHOP inside a plain <span>/<a>.
    // We look for text nodes matching "FIADSHOP" (or "FIAD" + "SHOP") that aren't already handled.
    // Skipped by default to avoid false positives; call FiadUI.replaceInline(el, size) manually if needed.
  }

  /**
   * Manually swap an element's contents for the logo (useful for the footer text-logo).
   */
  function replaceInline(el, size = 28) {
    if (!el) return;
    el.innerHTML = logoHTML(size);
  }

  // ==========================================================================
  //  3-DOT MENU
  //  ---------------------------------------------------------------------
  //  Placement: any <div data-fiad-menu></div>  — usually inside the navbar
  //  next to the cart icon. Renders a role-aware dropdown per the spec:
  //    Guest:  Shop Now, Earn With Us, Login, AI Chat
  //    User :  Hi {name}, Earn With Us, Open Pro Account | Affiliate Dashboard,
  //            AI Chat, Profile Settings, My Orders, Logout
  //    Admin:  ↑ + Admin Panel
  // ==========================================================================

  function menuHTML() {
    return `
<div class="relative fiad-menu-root">
  <button type="button" class="fiad-menu-btn p-2 rounded-full bg-gray-100 dark:bg-zinc-800 text-gray-600 dark:text-gray-300 hover:scale-105 transition focus:outline-none"
          aria-label="More" aria-haspopup="true" aria-expanded="false">
    <i class="fa-solid fa-ellipsis-vertical text-sm"></i>
  </button>
  <div class="fiad-menu-panel hidden absolute right-0 mt-2 w-60 bg-white dark:bg-zinc-900 border border-gray-200 dark:border-zinc-800 rounded-xl shadow-xl overflow-hidden z-[100]" role="menu">
    <div class="fiad-menu-body p-1 text-sm"></div>
  </div>
</div>`.trim();
  }

  function menuItem({ icon, label, href, onClick, badge, danger }) {
    const cls =
      'flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer transition ' +
      (danger
        ? 'text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40'
        : 'text-gray-700 dark:text-gray-200 hover:bg-cta-50 dark:hover:bg-zinc-800 hover:text-cta-600 dark:hover:text-cta-400');
    const badgeHtml = badge
      ? `<span class="ml-auto text-[10px] font-bold bg-cta-500 text-white px-2 py-0.5 rounded-full">${escapeHtml(badge)}</span>`
      : '';
    const iconHtml = `<i class="fa-solid ${icon} w-4 text-center"></i>`;
    const inner = `${iconHtml}<span class="flex-1">${escapeHtml(label)}</span>${badgeHtml}`;
    if (onClick) {
      return `<button type="button" role="menuitem" class="${cls} w-full text-left" data-onclick="${onClick}">${inner}</button>`;
    }
    return `<a role="menuitem" href="${href}" class="${cls}">${inner}</a>`;
  }

  function renderMenuBody(panelBody) {
    const user = global.FiadAuth?.getUser();
    const isAdmin = global.FiadAuth?.isAdmin();
    const isAff = global.FiadAuth?.isAffiliate();

    const items = [];

    if (user) {
      items.push(`
        <div class="px-3 py-2 border-b border-gray-100 dark:border-zinc-800">
          <div class="text-xs text-gray-500 dark:text-gray-400">Signed in as</div>
          <div class="font-semibold truncate">Hi, ${escapeHtml(user.displayName || user.username || 'friend')}</div>
        </div>`);
      items.push(menuItem({ icon: 'fa-bag-shopping', label: 'Shop Now',       href: 'products.html' }));
      items.push(menuItem({ icon: 'fa-lightbulb',    label: 'Earn With Us',   href: 'earn-with-us.html' }));
      if (isAff) {
        items.push(menuItem({ icon: 'fa-chart-line', label: 'Affiliate Dashboard', href: 'affiliate-dashboard.html', badge: 'Pro' }));
      } else {
        items.push(menuItem({ icon: 'fa-rocket',     label: 'Open Pro Account', onClick: 'openProAccount' }));
      }
      items.push(menuItem({ icon: 'fa-robot',        label: 'AI Chat',        href: 'ai.html' }));
      items.push(menuItem({ icon: 'fa-box',          label: 'My Orders',      href: 'order-tracking.html' }));
      items.push(menuItem({ icon: 'fa-user-gear',    label: 'Profile Settings', href: 'login.html#profile' }));
      if (isAdmin) {
        items.push(menuItem({ icon: 'fa-shield-halved', label: 'Admin Panel', href: 'admin-panel.html', badge: 'Admin' }));
      }
      items.push(`<div class="my-1 border-t border-gray-100 dark:border-zinc-800"></div>`);
      items.push(menuItem({ icon: 'fa-arrow-right-from-bracket', label: 'Logout', onClick: 'logout', danger: true }));
    } else {
      items.push(menuItem({ icon: 'fa-bag-shopping', label: 'Shop Now',     href: 'products.html' }));
      items.push(menuItem({ icon: 'fa-lightbulb',    label: 'Earn With Us', href: 'earn-with-us.html' }));
      items.push(menuItem({ icon: 'fa-robot',        label: 'AI Chat',      href: 'ai.html' }));
      items.push(`<div class="my-1 border-t border-gray-100 dark:border-zinc-800"></div>`);
      items.push(menuItem({ icon: 'fa-right-to-bracket', label: 'Login / Register', href: 'login.html' }));
    }

    panelBody.innerHTML = items.join('');

    // Wire button-onclick actions
    panelBody.querySelectorAll('[data-onclick]').forEach(btn => {
      const action = btn.getAttribute('data-onclick');
      btn.addEventListener('click', async () => {
        if (action === 'logout') {
          global.FiadAuth.logout();
        } else if (action === 'openProAccount') {
          try {
            await api.post('/affiliate/apply', {});
            toast('Welcome — you are now an affiliate!', 'success');
            await global.FiadAuth.refreshMe();
            setTimeout(() => { location.href = 'affiliate-dashboard.html'; }, 500);
          } catch (e) {
            toast(e.message || 'Could not open Pro account', 'error');
          }
        }
      });
    });
  }

  function mountMenus() {
    document.querySelectorAll('[data-fiad-menu]').forEach(el => {
      el.innerHTML = menuHTML();
      const root = el.querySelector('.fiad-menu-root');
      const btn = root.querySelector('.fiad-menu-btn');
      const panel = root.querySelector('.fiad-menu-panel');
      const body = root.querySelector('.fiad-menu-body');

      const open = () => {
        renderMenuBody(body);
        panel.classList.remove('hidden');
        btn.setAttribute('aria-expanded', 'true');
      };
      const close = () => {
        panel.classList.add('hidden');
        btn.setAttribute('aria-expanded', 'false');
      };
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        panel.classList.contains('hidden') ? open() : close();
      });
      document.addEventListener('click', (e) => {
        if (!root.contains(e.target)) close();
      });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    });
  }

  // Re-render open menus after auth state changes
  document.addEventListener('fiad:auth-changed', () => {
    document.querySelectorAll('.fiad-menu-panel .fiad-menu-body').forEach(renderMenuBody);
  });

  // ==========================================================================
  //  FLOATING AI BOT
  //  Auto-mounted bottom-right on every page. Skip on ai.html / admin pages.
  // ==========================================================================
  function mountFloatingAi() {
    if (document.querySelector('.fiad-fab-ai')) return;
    const path = location.pathname.toLowerCase();
    if (path.endsWith('/ai.html') || path.includes('admin-')) return;

    const wrap = document.createElement('div');
    wrap.className = 'fiad-fab-ai fixed z-[80] bottom-5 right-5 flex flex-col items-end gap-2';
    wrap.innerHTML = `
      <a href="ai.html"
         class="group flex items-center gap-2 bg-cta-500 hover:bg-cta-600 text-white pl-3 pr-4 py-3 rounded-full shadow-lg shadow-cta-500/30 transition-all hover:scale-105"
         aria-label="Ask Fiad AI">
        <span class="relative inline-flex items-center justify-center w-6 h-6 rounded-full bg-white/20">
          <i class="fa-solid fa-robot text-sm"></i>
          <span class="absolute -top-1 -right-1 w-2.5 h-2.5 bg-green-400 rounded-full ring-2 ring-cta-500"></span>
        </span>
        <span class="hidden xs:inline text-sm font-bold">Ask Fiad AI</span>
      </a>`;
    document.body.appendChild(wrap);
  }

  // ==========================================================================
  //  LIVE SUPPORT BUTTON
  //  Sits above the AI bot when backend reports isLiveEnabled=true.
  //  Actual chat UI is a lightweight modal that publishes via /support endpoints.
  //  (Ably SDK is loaded on-demand only when the user opens the chat, to keep
  //   pages fast for visitors who never use it.)
  // ==========================================================================
  async function mountLiveSupport() {
    if (document.querySelector('.fiad-fab-support')) return;
    let status;
    try { status = await api.get('/support/status'); }
    catch { return; }  // silent — support just won't appear

    const wrap = document.createElement('div');
    wrap.className = 'fiad-fab-support fixed z-[81] bottom-20 right-5';

    if (status.isLiveEnabled) {
      wrap.innerHTML = `
        <button type="button"
                class="flex items-center gap-2 bg-white dark:bg-zinc-900 border border-gray-200 dark:border-zinc-800 hover:border-cta-500 text-gray-800 dark:text-gray-100 pl-3 pr-4 py-2.5 rounded-full shadow-lg transition-all hover:scale-105"
                aria-label="Chat with support">
          <span class="relative inline-flex items-center justify-center w-6 h-6 rounded-full bg-green-100 dark:bg-green-900/40 text-green-600 dark:text-green-400">
            <i class="fa-solid fa-headset text-xs"></i>
            <span class="absolute -top-0.5 -right-0.5 w-2 h-2 bg-green-500 rounded-full animate-pulse"></span>
          </span>
          <span class="hidden xs:inline text-xs font-semibold">Live Support</span>
        </button>`;
    } else {
      wrap.innerHTML = `
        <button type="button"
                class="flex items-center gap-2 bg-white dark:bg-zinc-900 border border-gray-200 dark:border-zinc-800 text-gray-500 dark:text-gray-400 pl-3 pr-4 py-2.5 rounded-full shadow-lg transition-all hover:border-cta-500"
                aria-label="Leave a message">
          <span class="relative inline-flex items-center justify-center w-6 h-6 rounded-full bg-gray-100 dark:bg-zinc-800">
            <i class="fa-solid fa-envelope text-xs"></i>
          </span>
          <span class="hidden xs:inline text-xs font-semibold">Leave a message</span>
        </button>`;
    }

    document.body.appendChild(wrap);
    wrap.querySelector('button').addEventListener('click', () => {
      // If the real-time module is loaded and support is enabled, use it.
      // Otherwise fall back to the local persist-only modal below.
      if (status.isLiveEnabled && global.FiadSupportChat?.openCustomer) {
        global.FiadSupportChat.openCustomer();
      } else {
        openSupportChat(status);
      }
    });
  }

  function openSupportChat(status) {
    const existing = document.getElementById('fiad-support-modal');
    if (existing) { existing.remove(); return; }

    const online = status.isLiveEnabled;
    const modal = document.createElement('div');
    modal.id = 'fiad-support-modal';
    modal.className = 'fixed inset-0 z-[9998] flex items-end sm:items-center justify-center bg-black/40 p-4';
    modal.innerHTML = `
      <div class="w-full max-w-md bg-white dark:bg-zinc-900 border border-gray-200 dark:border-zinc-800 rounded-2xl shadow-2xl overflow-hidden">
        <div class="flex items-center justify-between px-4 py-3 border-b border-gray-100 dark:border-zinc-800 bg-cta-500 text-white">
          <div class="flex items-center gap-2">
            <i class="fa-solid ${online ? 'fa-headset' : 'fa-envelope'}"></i>
            <div>
              <div class="text-sm font-bold">${online ? 'Live Support' : 'Leave a Message'}</div>
              <div class="text-[11px] opacity-80">${online ? 'Usually replies in a few minutes' : "We'll reply by email"}</div>
            </div>
          </div>
          <button type="button" aria-label="Close" class="fiad-close-support text-white/80 hover:text-white text-lg leading-none">&times;</button>
        </div>
        <div class="p-4 space-y-3 text-sm">
          ${online ? `
            <div id="fiad-support-messages" class="h-56 overflow-y-auto space-y-2 bg-gray-50 dark:bg-zinc-950 rounded-lg p-3 border border-gray-100 dark:border-zinc-800">
              <div class="text-xs text-gray-500 dark:text-gray-400 text-center">Start a conversation…</div>
            </div>
            <input type="email" id="fiad-support-email" placeholder="Your email" class="w-full px-3 py-2 rounded-lg bg-gray-50 dark:bg-zinc-950 border border-gray-200 dark:border-zinc-800 focus:border-cta-500 focus:outline-none">
            <div class="flex gap-2">
              <input type="text" id="fiad-support-input" placeholder="Type a message…" class="flex-1 px-3 py-2 rounded-lg bg-gray-50 dark:bg-zinc-950 border border-gray-200 dark:border-zinc-800 focus:border-cta-500 focus:outline-none">
              <button type="button" id="fiad-support-send" class="bg-cta-500 hover:bg-cta-600 text-white font-bold px-4 rounded-lg transition"><i class="fa-solid fa-paper-plane"></i></button>
            </div>
          ` : `
            <p class="text-gray-600 dark:text-gray-400">${escapeHtml(status.offlineMessage || "We're offline right now.")}</p>
            <input type="email" id="fiad-support-email" placeholder="Your email" class="w-full px-3 py-2 rounded-lg bg-gray-50 dark:bg-zinc-950 border border-gray-200 dark:border-zinc-800 focus:border-cta-500 focus:outline-none">
            <textarea id="fiad-support-msg" rows="4" placeholder="Your message…" class="w-full px-3 py-2 rounded-lg bg-gray-50 dark:bg-zinc-950 border border-gray-200 dark:border-zinc-800 focus:border-cta-500 focus:outline-none"></textarea>
            <button type="button" id="fiad-support-send-offline" class="w-full bg-cta-500 hover:bg-cta-600 text-white font-bold py-2.5 rounded-lg transition">Send message</button>
          `}
        </div>
      </div>`;
    document.body.appendChild(modal);
    modal.querySelector('.fiad-close-support').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

    if (online) wireLiveChat(modal);
    else wireOfflineChat(modal);
  }

  async function wireLiveChat(modal) {
    const user = global.FiadAuth?.getUser();
    const emailInput = modal.querySelector('#fiad-support-email');
    if (user?.email) { emailInput.value = user.email; emailInput.disabled = true; }
    const list = modal.querySelector('#fiad-support-messages');
    const input = modal.querySelector('#fiad-support-input');
    const send = modal.querySelector('#fiad-support-send');
    let sessionId = null;

    function push(sender, message) {
      const mine = sender === 'user';
      const div = document.createElement('div');
      div.className = 'flex ' + (mine ? 'justify-end' : 'justify-start');
      div.innerHTML = `<div class="max-w-[80%] px-3 py-2 rounded-lg text-xs ${
        mine ? 'bg-cta-500 text-white' : 'bg-white dark:bg-zinc-800 text-gray-800 dark:text-gray-100 border border-gray-200 dark:border-zinc-700'
      }">${escapeHtml(message)}</div>`;
      list.appendChild(div);
      list.scrollTop = list.scrollHeight;
    }

    async function ensureSession() {
      if (sessionId) return sessionId;
      const email = emailInput.value.trim();
      if (!email) { toast('Please enter your email', 'warn'); throw new Error('email'); }
      const res = await api.post('/support/session', { email });
      sessionId = res.sessionId;
      list.querySelector('.text-center')?.remove();
      push('system', 'Connected. An agent will be with you shortly.');
      return sessionId;
    }

    async function sendMessage() {
      const msg = input.value.trim();
      if (!msg) return;
      try {
        const id = await ensureSession();
        push('user', msg);
        input.value = '';
        await api.post(`/support/session/${id}/message`, { sender: 'user', message: msg });
      } catch (e) {
        if (e.message !== 'email') toast(e.message || 'Failed to send', 'error');
      }
    }
    send.addEventListener('click', sendMessage);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendMessage(); });
  }

  function wireOfflineChat(modal) {
    const btn = modal.querySelector('#fiad-support-send-offline');
    btn.addEventListener('click', async () => {
      const email = modal.querySelector('#fiad-support-email').value.trim();
      const message = modal.querySelector('#fiad-support-msg').value.trim();
      if (!email || !message) { toast('Please fill both fields', 'warn'); return; }
      try {
        await api.post('/feedback', {
          type: 'SUGGESTION', title: 'Support message (offline)', description: message, guestEmail: email,
        });
        toast("Message sent — we'll email you back.", 'success');
        modal.remove();
      } catch (e) { toast(e.message || 'Could not send', 'error'); }
    });
  }

  // ==========================================================================
  //  DARK MODE — respect existing #dark-mode-toggle if present, else self-manage
  // ==========================================================================
  function initDarkMode() {
    const KEY = 'fiad_theme';
    const html = document.documentElement;
    const stored = localStorage.getItem(KEY);
    const prefersDark = !!(window.matchMedia &&
                           window.matchMedia('(prefers-color-scheme: dark)').matches);
    if (stored === 'dark' || (!stored && prefersDark)) html.classList.add('dark');

    function apply(dark) {
      html.classList.toggle('dark', dark);
      localStorage.setItem(KEY, dark ? 'dark' : 'light');
      document.querySelectorAll('#theme-icon').forEach(i => {
        i.classList.remove('fa-moon', 'fa-sun');
        i.classList.add(dark ? 'fa-sun' : 'fa-moon');
      });
    }
    apply(html.classList.contains('dark'));

    document.querySelectorAll('#dark-mode-toggle').forEach(btn => {
      btn.addEventListener('click', () => apply(!html.classList.contains('dark')));
    });
  }

  // ==========================================================================
  //  BOOT
  // ==========================================================================
  function boot() {
    // Each step is wrapped so one failure doesn't stop the others.
    const steps = [
      ['mountLogos',       mountLogos],
      ['mountMenus',       mountMenus],
      ['initDarkMode',     initDarkMode],
      ['mountFloatingAi',  mountFloatingAi],
      ['mountLiveSupport', mountLiveSupport],
    ];
    for (const [name, fn] of steps) {
      try { fn(); }
      catch (e) { console.error('[FiadUI:' + name + ']', e); }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  global.FiadUI = { logoHTML, mountLogos, mountMenus, replaceInline, boot };
})(window);
