// Ably server-side helper.
// - Issues short-lived tokenRequests to browsers (so we never expose the root key).
// - Publishes server messages onto session channels.
// - Enforces capability scoping so clients can only touch their own channel.

const Ably = require('ably');

let restClient = null;
function rest() {
  if (!restClient) {
    if (!process.env.ABLY_API_KEY) {
      throw new Error('ABLY_API_KEY not configured');
    }
    restClient = new Ably.Rest({ key: process.env.ABLY_API_KEY });
  }
  return restClient;
}

const ROOT_CHANNEL = process.env.ABLY_CHANNEL_NAME || 'fiad-live-support';

function sessionChannelName(sessionId) {
  return `${ROOT_CHANNEL}:session:${sessionId}`;
}
function adminNotifyChannel() {
  return `${ROOT_CHANNEL}:admin-notify`;
}

/**
 * Create a tokenRequest the browser can use to auth against Ably.
 * Callers MUST specify the intended capability. If none is provided, we deny
 * everything except public presence heartbeat.
 *
 * @param {string} clientId
 * @param {object} capability  Ably capability map { channel: [ops] }
 * @param {number} [ttlMs]     default 60 min
 */
async function createTokenRequest(clientId, capability, ttlMs) {
  return new Promise((resolve, reject) => {
    rest().auth.createTokenRequest({
      clientId,
      capability: capability || { '__none__': ['presence'] },
      ttl: ttlMs || 60 * 60 * 1000,
    }, (err, tokenRequest) => {
      if (err) return reject(err);
      resolve(tokenRequest);
    });
  });
}

/** Capability for a customer joining exactly one session. */
function sessionCapability(sessionId) {
  const ch = sessionChannelName(sessionId);
  return { [ch]: ['subscribe', 'publish', 'presence'] };
}

/** Capability for an admin: watch new-session announcements + join any session. */
function adminCapability() {
  return {
    [adminNotifyChannel()]:              ['subscribe', 'publish', 'presence'],
    [`${ROOT_CHANNEL}:session:*`]:       ['subscribe', 'publish', 'presence'],
  };
}

/** Publish a message onto a session channel from the server. */
async function publish(sessionId, event, data) {
  const channelName = sessionId === 'admin-notify'
    ? adminNotifyChannel()
    : sessionChannelName(sessionId);
  const channel = rest().channels.get(channelName);
  return channel.publish(event, data);
}

module.exports = {
  createTokenRequest,
  sessionCapability,
  adminCapability,
  publish,
  sessionChannelName,
  adminNotifyChannel,
  ROOT_CHANNEL,
};

