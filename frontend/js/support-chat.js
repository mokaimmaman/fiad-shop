/* ============================================================================
 * Fiad Shop — Live Support real-time layer (Ably)
 * ----------------------------------------------------------------------------
 * Bi-directional chat between customers and admins. Two entry points:
 *
 *   1. FiadSupportChat.openCustomer({ email })
 *          → used by the floating widget in js/ui.js
 *          → creates a session, subscribes to that session's channel,
 *            publishes user messages, receives admin messages in realtime.
 *
 *   2. FiadSupportChat.openAdmin({ sessionId })
 *          → used by admin-panel.html Live Support section
 *          → subscribes to a specific session's channel + admin-notify
 *            channel (so admins get toast pings when new sessions open),
 *            publishes admin messages, sees typing indicators, presence.
 *
 * The Ably JS SDK (~120 KB gzipped) is lazy-loaded from the CDN the FIRST
 * time a chat is opened — normal page loads pay zero cost.
 *
 * Every message is ALSO persisted server-side via POST /support/session/:id/message
 * so history survives refreshes and admins can catch up on offline sessions.
 *
 * If Ably fails (no key, blocked, offline), the widget falls back to the
 * persist-only flow — messages still send, they just don't arrive in real time.
 * ========================================================================== */

(function (global) {
  'use strict';

  const { api, toast, escapeHtml } = global.FiadAPI;

  const ABLY_SDK_URL = 'https://cdn.ably.com/lib/ably.min-2.js';
  let ablyLoadPromise = null;
  function loadAblySdk() {
    if (global.Ably) return Promise.resolve(global.Ably);
    if (ablyLoadPromise) return ablyLoadPromise;
    ablyLoadPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = ABLY_SDK_URL;
      s.async = true;
      s.onload = () => global.Ably ? resolve(global.Ably) : reject(new Error('Ably loaded but global missing'));
      s.onerror = () => reject(new Error('Failed to load Ably SDK'));
      document.head.appendChild(s);
    });
    return ablyLoadPromise;
  }

  // ---------------------------------------------------------------------------
  // Low-level connector — used by both customer & admin widgets
  // ---------------------------------------------------------------------------

  /**
   * @param {object}  opts
   * @param {string}  opts.mode          'customer' | 'admin'
   * @param {string}  [opts.sessionId]   required for customer + admin session chat
   * @param {function} opts.onMessage    ({ sender, message, timestamp, clientId }) => void
   * @param {function} [opts.onPresence] ({ action, clientId }) => void  (enter/leave/update)
   * @param {function} [opts.onTyping]   ({ clientId, isTyping }) => void
   * @param {function} [opts.onAdminNotify] ({ sessionId, email, channel }) => void  (admin mode only)
   * @param {function} [opts.onStatus]   ({ state, reason }) => void  (connected/disconnected/failed)
   *
   * @returns {Promise<Connection>}
   *   .publish(message)   — send a message (also persists via API)
   *   .typing(isTyping)   — send typing indicator
   *   .close()            — leave & disconnect
   */
  async function connect(opts) {
    const status = (s, r) => opts.onStatus && opts.onStatus({ state: s, reason: r });
    status('loading');

    // 1. Load the Ably SDK
    let Ably;
    try { Ably = await loadAblySdk(); }
    catch (e) { status('failed', e.message); throw e; }

    // 2. Get a server-signed tokenRequest
    let tokenInfo;
    try {
      const path = opts.mode === 'admin'
        ? '/support/admin/token'
        : '/support/token?sessionId=' + encodeURIComponent(opts.sessionId);
      tokenInfo = await api.get(path);
    } catch (e) { status('failed', e.message); throw e; }

    // 3. Realtime client — authCallback returns the tokenRequest we already
    // fetched; Ably will call it again if the token needs to be renewed.
    let firstAuth = true;
    const realtime = new Ably.Realtime({
      authCallback: async (_data, cb) => {
        try {
          if (firstAuth) { firstAuth = false; return cb(null, tokenInfo.tokenRequest); }
          const path = opts.mode === 'admin'
            ? '/support/admin/token'
            : '/support/token?sessionId=' + encodeURIComponent(opts.sessionId);
          const fresh = await api.get(path);
          cb(null, fresh.tokenRequest);
        } catch (e) { cb(e, null); }
      },
      clientId: tokenInfo.clientId,
      echoMessages: false,
      autoConnect: true,
    });

    realtime.connection.on('connected',    () => status('connected'));
    realtime.connection.on('disconnected', () => status('disconnected'));
    realtime.connection.on('failed', (e) => status('failed', e?.reason?.message));

    // 4. Subscribe to session channel (both modes need this)
    const sessionChannel = opts.sessionId ? realtime.channels.get(tokenInfo.channel
        || ('fiad-live-support:session:' + opts.sessionId)) : null;

    if (sessionChannel) {
      sessionChannel.subscribe('message', (msg) => {
        // Filter out our own echoes just in case
        if (msg.clientId === tokenInfo.clientId) return;
        opts.onMessage && opts.onMessage({
          sender: msg.data?.sender || 'other',
          message: msg.data?.message || '',
          timestamp: msg.data?.timestamp || new Date(msg.timestamp).toISOString(),
          clientId: msg.clientId,
        });
      });
      sessionChannel.subscribe('typing', (msg) => {
        if (msg.clientId === tokenInfo.clientId) return;
        opts.onTyping && opts.onTyping({
          clientId: msg.clientId,
          isTyping: !!msg.data?.isTyping,
        });
      });
      sessionChannel.presence.subscribe((m) => {
        opts.onPresence && opts.onPresence({ action: m.action, clientId: m.clientId });
      });
      try { await sessionChannel.presence.enter({ role: opts.mode }); } catch {}
    }

    // 5. Admin also subscribes to the notify channel
    let notifyChannel = null;
    if (opts.mode === 'admin') {
      notifyChannel = realtime.channels.get(tokenInfo.adminNotifyChannel);
      notifyChannel.subscribe('session-created', (msg) => {
        opts.onAdminNotify && opts.onAdminNotify(msg.data || {});
      });
    }

    // ---- Publish helpers ----------------------------------------------------
    // Persist first (server is source of truth), then broadcast via Ably.
    // If Ably fails the message is still saved (users just won't see it live).
    let typingDebounce = null;
    const conn = {
      clientId: tokenInfo.clientId,
      channel: sessionChannel,
      realtime,

      async publish(message) {
        if (!opts.sessionId) throw new Error('No sessionId');
        const payload = {
          sender:    opts.mode === 'admin' ? 'admin' : 'user',
          message,
          timestamp: new Date().toISOString(),
        };
        // Persist
        try {
          await api.post('/support/session/' + opts.sessionId + '/message', {
            sender: payload.sender, message,
          });
        } catch (e) { toast(e.message || 'Failed to save message', 'error'); throw e; }
        // Broadcast (best-effort)
        try { sessionChannel && await sessionChannel.publish('message', payload); }
        catch (e) { console.warn('[chat] Ably publish failed:', e.message); }
        return payload;
      },

      typing(isTyping) {
        if (!sessionChannel) return;
        // Debounce to avoid flooding — send at most one event every 800ms.
        if (typingDebounce) clearTimeout(typingDebounce);
        typingDebounce = setTimeout(() => {
          try { sessionChannel.publish('typing', { isTyping }); } catch {}
        }, 200);
      },

      close() {
        try { sessionChannel && sessionChannel.presence.leave().catch(() => {}); } catch {}
        try { realtime.close(); } catch {}
      },
    };

    return conn;
  }

  // ---------------------------------------------------------------------------
  // Customer widget — replaces the persist-only modal from js/ui.js
  // ---------------------------------------------------------------------------
  //
  // Renders a small, self-contained chat window with:
  //   - message list
  //   - email input (guests) / auto-filled (users)
  //   - text input + send button + typing indicator
  //   - connection status pill
  // Returns { close() } so the caller can dismiss it programmatically.

  function openCustomer({ containerParent } = {}) {
    // Prevent double-open
    const existing = document.getElementById('fiad-support-chat');
    if (existing) { existing.remove(); }

    const parent = containerParent || document.body;
    const modal = document.createElement('div');
    modal.id = 'fiad-support-chat';
    modal.className = 'fixed inset-0 z-[9998] flex items-end sm:items-center justify-center bg-black/40 p-4';
    modal.innerHTML = `
      <div class="w-full max-w-md bg-white dark:bg-zinc-900 border border-gray-200 dark:border-zinc-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col" style="max-height:80vh">
        <!-- Header -->
        <div class="flex items-center gap-3 px-4 py-3 bg-cta-500 text-white">
          <div class="relative w-9 h-9 rounded-full bg-white/20 flex items-center justify-center flex-shrink-0">
            <i class="fa-solid fa-headset text-sm"></i>
            <span id="fsc-status-dot" class="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 bg-yellow-400 rounded-full ring-2 ring-cta-500"></span>
          </div>
          <div class="flex-1 min-w-0">
            <div class="text-sm font-bold">Live Support</div>
            <div id="fsc-status" class="text-[10px] opacity-90">Connecting…</div>
          </div>
          <button type="button" aria-label="Close" class="fsc-close text-white/80 hover:text-white text-lg leading-none px-2">&times;</button>
        </div>

        <!-- Email prompt (shown until session opened) -->
        <div id="fsc-precall" class="p-4 space-y-3">
          <p class="text-xs text-gray-600 dark:text-gray-400">Enter your email to start a session. An agent will be with you shortly.</p>
          <input id="fsc-email" type="email" placeholder="you@example.com"
                 class="w-full px-3 py-2 rounded-lg bg-gray-50 dark:bg-zinc-950 border border-gray-200 dark:border-zinc-800 focus:border-cta-500 focus:outline-none text-sm">
          <button id="fsc-start" class="w-full bg-cta-500 hover:bg-cta-600 text-white font-bold py-2.5 rounded-lg text-sm transition">
            Start chat
          </button>
        </div>

        <!-- Chat area -->
        <div id="fsc-chat" class="hidden flex-1 flex flex-col min-h-0">
          <div id="fsc-messages" class="flex-1 overflow-y-auto p-3 space-y-2 bg-gray-50 dark:bg-zinc-950"></div>
          <div id="fsc-typing" class="hidden px-4 py-1 text-[10px] text-gray-400 italic">Support is typing…</div>
          <div class="p-3 border-t border-gray-100 dark:border-zinc-800 flex gap-2">
            <input id="fsc-input" type="text" placeholder="Type a message…"
                   class="flex-1 px-3 py-2 rounded-lg bg-gray-50 dark:bg-zinc-950 border border-gray-200 dark:border-zinc-800 focus:border-cta-500 focus:outline-none text-sm">
            <button id="fsc-send" class="bg-cta-500 hover:bg-cta-600 text-white font-bold px-4 rounded-lg text-sm transition disabled:opacity-50">
              <i class="fa-solid fa-paper-plane"></i>
            </button>
          </div>
        </div>
      </div>`;
    parent.appendChild(modal);

    const $ = (id) => modal.querySelector('#' + id);
    const emailInput = $('fsc-email');
    const startBtn = $('fsc-start');
    const chatArea = $('fsc-chat');
    const precall = $('fsc-precall');
    const list = $('fsc-messages');
    const input = $('fsc-input');
    const send = $('fsc-send');
    const typingEl = $('fsc-typing');
    const statusEl = $('fsc-status');
    const statusDot = $('fsc-status-dot');

    // Prefill email if logged in
    const u = global.FiadAuth?.getUser();
    if (u?.email) { emailInput.value = u.email; }

    let conn = null;
    let sessionId = null;
    let typingHideTimer = null;

    function setStatus(state, label) {
      const colors = {
        loading:      ['bg-yellow-400', 'Connecting…'],
        connected:    ['bg-green-400',  'Online'],
        disconnected: ['bg-orange-400', 'Reconnecting…'],
        failed:       ['bg-red-500',    'Offline — messages will still send'],
        fallback:     ['bg-orange-400', 'Persist-only mode'],
      };
      const [dotCls, defaultLabel] = colors[state] || colors.loading;
      statusEl.textContent = label || defaultLabel;
      statusDot.className = 'absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full ring-2 ring-cta-500 ' + dotCls;
    }

    function appendMsg(sender, message, timestamp) {
      const mine = sender === 'user';
      const el = document.createElement('div');
      el.className = 'flex ' + (mine ? 'justify-end' : sender === 'system' ? 'justify-center' : 'justify-start');
      const bubbleCls = mine
        ? 'bg-cta-500 text-white rounded-2xl rounded-br-sm'
        : sender === 'system'
          ? 'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-800 dark:text-yellow-300 rounded-full text-[10px]'
          : 'bg-white dark:bg-zinc-800 border border-gray-200 dark:border-zinc-700 rounded-2xl rounded-bl-sm';
      el.innerHTML = `
        <div class="max-w-[80%] px-3 py-2 ${bubbleCls}">
          <div class="text-xs whitespace-pre-wrap break-words">${escapeHtml(message)}</div>
          ${sender !== 'system' ? `<div class="text-[9px] opacity-70 mt-0.5">${new Date(timestamp || Date.now()).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' })}</div>` : ''}
        </div>`;
      list.appendChild(el);
      list.scrollTop = list.scrollHeight;
    }

    async function startChat() {
      const email = emailInput.value.trim();
      if (!email) return toast('Please enter your email', 'warn');
      startBtn.disabled = true;
      startBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i>Starting…';

      // 1. Create the DB session
      let sessRes;
      try { sessRes = await api.post('/support/session', { email }); }
      catch (e) {
        startBtn.disabled = false; startBtn.innerHTML = 'Start chat';
        if (e.data?.code === 'SUPPORT_OFFLINE') {
          return toast(e.data.offlineMessage || 'Support is offline right now', 'warn');
        }
        return toast(e.message || 'Could not start chat', 'error');
      }
      sessionId = sessRes.sessionId;
      precall.classList.add('hidden');
      chatArea.classList.remove('hidden');
      chatArea.style.display = 'flex';
      appendMsg('system', 'Session started — an agent will join shortly.');

      // 2. Connect Ably
      try {
        conn = await connect({
          mode: 'customer', sessionId,
          onStatus:   ({ state }) => setStatus(state),
          onMessage:  ({ sender, message, timestamp }) => {
            if (sender === 'admin') appendMsg('admin', message, timestamp);
            else if (sender === 'system') appendMsg('system', message);
          },
          onPresence: ({ action, clientId }) => {
            if (clientId?.startsWith('admin-') && action === 'enter') {
              appendMsg('system', 'An agent has joined the chat.');
            }
          },
          onTyping: ({ isTyping, clientId }) => {
            if (!clientId?.startsWith('admin-')) return;
            typingEl.classList.toggle('hidden', !isTyping);
            if (isTyping) {
              clearTimeout(typingHideTimer);
              typingHideTimer = setTimeout(() => typingEl.classList.add('hidden'), 3000);
            }
          },
        });
      } catch (e) {
        console.warn('[support-chat] Ably unavailable:', e.message);
        setStatus('fallback');
        toast('Realtime unavailable — messages will still be delivered by email.', 'warn');
      }
    }

    async function sendMessage() {
      const message = input.value.trim();
      if (!message || !sessionId) return;
      send.disabled = true;
      appendMsg('user', message);
      input.value = '';
      try {
        if (conn) await conn.publish(message);
        else {
          // Fallback: persist directly
          await api.post('/support/session/' + sessionId + '/message', { sender: 'user', message });
        }
      } catch (e) { toast(e.message || 'Send failed', 'error'); }
      finally { send.disabled = false; input.focus(); }
    }

    function close() {
      try { conn && conn.close(); } catch {}
      modal.remove();
    }

    startBtn.addEventListener('click', startChat);
    emailInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') startChat(); });
    send.addEventListener('click', sendMessage);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendMessage();
      else if (conn) conn.typing(true);
    });
    input.addEventListener('blur', () => conn && conn.typing(false));
    modal.querySelector('.fsc-close').addEventListener('click', close);
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

    return { close };
  }

  // ---------------------------------------------------------------------------
  // Admin widget — richer chat window mounted inside the admin panel
  // ---------------------------------------------------------------------------

  async function openAdmin({ sessionId, container }) {
    if (!sessionId) throw new Error('sessionId required');
    if (!container) throw new Error('container required');

    // Pull session history first
    let session;
    try {
      const res = await api.get('/support/session/' + sessionId);
      session = res.session;
    } catch (e) { toast(e.message || 'Session not found', 'error'); return; }

    container.innerHTML = `
      <div class="admin-card bg-white dark:bg-zinc-900 rounded-xl overflow-hidden flex flex-col" style="height:70vh">
        <div class="flex items-center gap-3 px-4 py-3 border-b border-gray-100 dark:border-zinc-800">
          <div class="w-9 h-9 rounded-full bg-cta-500 text-white flex items-center justify-center flex-shrink-0">
            <i class="fa-solid fa-user text-xs"></i>
          </div>
          <div class="flex-1 min-w-0">
            <div class="text-sm font-bold truncate">${escapeHtml(session.email)}</div>
            <div id="adm-status" class="text-[10px] text-gray-500">Connecting…</div>
          </div>
          <span class="status-pill status-${session.status === 'ACTIVE' ? 'SHIPPED' : 'PENDING'}">${session.status}</span>
          <button id="adm-close-session" class="text-xs text-red-500 hover:text-red-600 font-semibold px-2">Close session</button>
          <button id="adm-back" class="text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 px-2">← Back</button>
        </div>

        <div id="adm-messages" class="flex-1 overflow-y-auto p-4 space-y-2 bg-gray-50 dark:bg-zinc-950"></div>
        <div id="adm-typing" class="hidden px-4 py-1 text-[10px] text-gray-400 italic">Customer is typing…</div>

        <div class="p-3 border-t border-gray-100 dark:border-zinc-800 flex gap-2">
          <input id="adm-input" type="text" placeholder="Type a reply…" ${session.status === 'CLOSED' ? 'disabled' : ''}
                 class="flex-1 px-3 py-2 rounded-lg bg-gray-50 dark:bg-zinc-950 border border-gray-200 dark:border-zinc-800 focus:border-cta-500 focus:outline-none text-sm">
          <button id="adm-send" class="bg-cta-500 hover:bg-cta-600 text-white font-bold px-4 rounded-lg text-sm disabled:opacity-50" ${session.status === 'CLOSED' ? 'disabled' : ''}>
            <i class="fa-solid fa-paper-plane"></i>
          </button>
        </div>
      </div>`;

    const $ = (id) => container.querySelector('#' + id);
    const list = $('adm-messages');
    const input = $('adm-input');
    const send = $('adm-send');
    const typingEl = $('adm-typing');
    const statusEl = $('adm-status');

    function appendMsg(sender, message, timestamp) {
      const mine = sender === 'admin';
      const el = document.createElement('div');
      el.className = 'flex ' + (mine ? 'justify-end' : sender === 'system' ? 'justify-center' : 'justify-start');
      const cls = mine
        ? 'bg-cta-500 text-white rounded-2xl rounded-br-sm'
        : sender === 'system'
          ? 'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-800 dark:text-yellow-300 rounded-full text-[10px]'
          : 'bg-white dark:bg-zinc-800 border border-gray-200 dark:border-zinc-700 rounded-2xl rounded-bl-sm';
      el.innerHTML = `
        <div class="max-w-[75%] px-3 py-2 ${cls}">
          <div class="text-xs whitespace-pre-wrap break-words">${escapeHtml(message)}</div>
          ${sender !== 'system' ? `<div class="text-[9px] opacity-70 mt-0.5">${new Date(timestamp || Date.now()).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' })}</div>` : ''}
        </div>`;
      list.appendChild(el);
      list.scrollTop = list.scrollHeight;
    }

    // Replay history
    (session.messages || []).forEach(m => appendMsg(m.sender, m.message, m.timestamp));
    if (!(session.messages || []).length) appendMsg('system', 'Session opened. No messages yet.');

    // Join session on the server (marks admin, updates status to ACTIVE)
    if (session.status !== 'CLOSED') {
      api.post('/support/admin/session/' + sessionId + '/join', {}).catch(() => {});
    }

    // Connect Ably
    let conn = null;
    let typingHideTimer = null;
    try {
      conn = await connect({
        mode: 'admin', sessionId,
        onStatus: ({ state }) => { statusEl.textContent = state === 'connected' ? 'Live' : state === 'loading' ? 'Connecting…' : state; },
        onMessage: ({ sender, message, timestamp }) => {
          if (sender === 'user') appendMsg('user', message, timestamp);
          else if (sender === 'system') appendMsg('system', message);
        },
        onTyping: ({ isTyping, clientId }) => {
          if (clientId?.startsWith('admin-')) return;
          typingEl.classList.toggle('hidden', !isTyping);
          if (isTyping) {
            clearTimeout(typingHideTimer);
            typingHideTimer = setTimeout(() => typingEl.classList.add('hidden'), 3000);
          }
        },
      });
    } catch (e) {
      statusEl.textContent = 'Persist-only';
      console.warn('[admin-chat] Ably unavailable:', e.message);
    }

    async function sendMessage() {
      const message = input.value.trim();
      if (!message) return;
      send.disabled = true;
      appendMsg('admin', message);
      input.value = '';
      try {
        if (conn) await conn.publish(message);
        else await api.post('/support/session/' + sessionId + '/message', { sender: 'admin', message });
      } catch (e) { toast(e.message || 'Send failed', 'error'); }
      finally { send.disabled = false; input.focus(); }
    }

    send.addEventListener('click', sendMessage);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendMessage();
      else if (conn) conn.typing(true);
    });
    input.addEventListener('blur', () => conn && conn.typing(false));

    $('adm-close-session').addEventListener('click', async () => {
      if (!confirm('Close this support session?')) return;
      try {
        await api.post('/support/admin/session/' + sessionId + '/close', {});
        appendMsg('system', 'Session closed.');
        input.disabled = true; send.disabled = true;
        try { conn && conn.close(); } catch {}
        toast('Session closed', 'success');
      } catch (e) { toast(e.message, 'error'); }
    });

    $('adm-back').addEventListener('click', () => {
      try { conn && conn.close(); } catch {}
      // Trigger the admin panel to re-render the sessions list
      global.dispatchEvent(new HashChangeEvent('hashchange'));
    });

    return {
      close: () => { try { conn && conn.close(); } catch {} },
    };
  }

  // ---------------------------------------------------------------------------
  // Admin notification stream — subscribes to admin-notify globally
  // (used by admin-panel.html to toast when new sessions open)
  // ---------------------------------------------------------------------------

  let notifyConn = null;
  async function subscribeAdminNotify({ onNewSession } = {}) {
    if (notifyConn) return notifyConn;
    try {
      notifyConn = await connect({
        mode: 'admin',
        // No sessionId — we only care about admin-notify
        onAdminNotify: (data) => onNewSession && onNewSession(data),
        onStatus: () => {},
      });
      return notifyConn;
    } catch (e) {
      console.warn('[admin-notify] Ably unavailable:', e.message);
      return null;
    }
  }
  function unsubscribeAdminNotify() {
    try { notifyConn && notifyConn.close(); } catch {}
    notifyConn = null;
  }

  // ---------------------------------------------------------------------------
  global.FiadSupportChat = {
    openCustomer,
    openAdmin,
    subscribeAdminNotify,
    unsubscribeAdminNotify,
    _connect: connect, // exposed for debugging
  };
})(window);
