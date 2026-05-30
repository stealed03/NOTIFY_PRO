/**
 * gramjs-client.js - GramJS Telegram user client
 * Monitors user account for: DMs, mentions, replies
 * Tries to keep messages unread (silent monitoring)
 */

const { TelegramClient, sessions } = require('telegram');
const { StringSession } = sessions;
const { NewMessage } = require('telegram/events');
const { Api } = require('telegram');
const path = require('path');
const fs = require('fs').promises;
const logger = require('../utils/logger');
const storage = require('../utils/storage');

// Map of userId → TelegramClient
const activeClients = new Map();

// ─── Initialize Client From Saved Session ─────────────────────────────────
async function startMonitoring(userId, onAlert) {
  // Prevent duplicate clients
  if (activeClients.has(userId)) {
    logger.warn(`Client already active for user ${userId}`);
    return activeClients.get(userId);
  }

  const user = await storage.getUser(userId);
  if (!user?.session) {
    throw new Error('No saved session for user ' + userId);
  }

  const apiId = user.status.loginData?.apiId;
  const apiHash = user.status.loginData?.apiHash;

  if (!apiId || !apiHash) {
    throw new Error('Missing API credentials for user ' + userId);
  }

  const stringSession = new StringSession(user.session);
  const client = new TelegramClient(stringSession, parseInt(apiId), apiHash, {
    connectionRetries: 5,
    retryDelay: 1000,
    autoReconnect: true,
    useWSS: false,
  });

  await client.connect();
  logger.info(`GramJS client connected for user ${userId}`);

  // Register event listener for new messages
  client.addEventHandler(
    async (event) => {
      try {
        await handleNewMessage(event, userId, user, onAlert, client);
      } catch (err) {
        logger.error(`Message handler error for ${userId}: ${err.message}`);
      }
    },
    new NewMessage({})
  );

  activeClients.set(userId, client);

  // Update user status
  await storage.updateUser(userId, u => ({
    ...u,
    settings: { ...u.settings, alertsEnabled: true },
  }));

  return client;
}

// ─── Handle Incoming Message ───────────────────────────────────────────────
async function handleNewMessage(event, userId, user, onAlert, client) {
  const msg = event.message;
  if (!msg || !msg.peerId) return;

  // Refresh user settings on each message
  const freshUser = await storage.getUser(userId);
  if (!freshUser?.settings?.alertsEnabled) return;

  const settings = freshUser.settings;
  const me = await client.getMe();
  const myId = me.id.toString();

  let alertType = null;
  let alertData = {};

  // ── Determine Alert Type ──────────────────────────────────────────────
  const isPrivate = msg.peerId.className === 'PeerUser';
  const isGroup = msg.peerId.className === 'PeerChat' || msg.peerId.className === 'PeerChannel';
  const isFromMe = msg.fromId?.userId?.toString() === myId;

  // Skip our own messages
  if (isFromMe) return;

  // Private message
  if (isPrivate && settings.dmAlerts) {
    alertType = 'privateMessage';
    alertData = {
      sender: await getSenderName(client, msg.fromId),
      message: truncate(msg.message || '[media]', 200),
      chatLink: `tg://user?id=${msg.peerId.userId}`,
      time: formatTime(msg.date),
    };
  }

  // Group message: check for mention or reply
  if (isGroup) {
    const isMentioned = await checkMention(msg, myId, me.username);
    const isReply = msg.replyTo?.replyToMsgId && await checkReplyToMe(client, msg, myId);

    if (isMentioned && settings.mentionAlerts) {
      alertType = 'mention';
      alertData = {
        sender: await getSenderName(client, msg.fromId),
        groupName: await getGroupName(client, msg.peerId),
        message: truncate(msg.message || '[media]', 200),
        time: formatTime(msg.date),
      };
    } else if (isReply && settings.replyAlerts) {
      alertType = 'reply';
      alertData = {
        sender: await getSenderName(client, msg.fromId),
        chatName: await getGroupName(client, msg.peerId),
        message: truncate(msg.message || '[media]', 200),
        time: formatTime(msg.date),
      };
    } else if (settings.groupAlerts && !isMentioned && !isReply) {
      // Don't alert on general group messages unless groupAlerts is on
      // groupAlerts = alert on ALL group messages (can be noisy, off by default)
      return;
    }
  }

  if (!alertType) return;

  // ── Silent Mode: Mark as unread after reading ─────────────────────────
  if (settings.silentMode) {
    try {
      await keepUnread(client, msg);
    } catch (err) {
      logger.debug(`Silent mode failed for ${userId}: ${err.message}`);
    }
  }

  // ── Increment alert counter ───────────────────────────────────────────
  await incrementAlertCount(userId);

  // ── Fire alert callback ───────────────────────────────────────────────
  await onAlert(userId, alertType, alertData);
}

// ─── Check if Message Mentions the User ───────────────────────────────────
async function checkMention(msg, myId, myUsername) {
  if (!msg.message) return false;
  const text = msg.message.toLowerCase();

  // Direct text mention
  if (myUsername && text.includes(`@${myUsername.toLowerCase()}`)) return true;

  // Entity-based mentions
  if (msg.entities) {
    for (const entity of msg.entities) {
      if (
        (entity.className === 'MessageEntityMentionName' && entity.userId?.toString() === myId) ||
        (entity.className === 'MessageEntityMention' && myUsername &&
          msg.message.substr(entity.offset, entity.length).includes(myUsername))
      ) {
        return true;
      }
    }
  }

  return false;
}

// ─── Check if Message is a Reply to My Message ─────────────────────────────
async function checkReplyToMe(client, msg, myId) {
  if (!msg.replyTo?.replyToMsgId) return false;
  try {
    const replied = await client.getMessages(msg.peerId, { ids: [msg.replyTo.replyToMsgId] });
    if (replied?.[0]) {
      return replied[0].fromId?.userId?.toString() === myId;
    }
  } catch (_) {}
  return false;
}

// ─── Keep Message Unread (Silent Mode) ────────────────────────────────────
async function keepUnread(client, msg) {
  // Mark as unread after a short delay
  // This uses Telegram's "mark unread" feature
  setTimeout(async () => {
    try {
      await client.invoke(new Api.messages.MarkDialogUnread({
        unread: true,
        peer: await client.getInputEntity(msg.peerId),
      }));
    } catch (_) {}
  }, 500);
}

// ─── Session Management ────────────────────────────────────────────────────
async function stopMonitoring(userId) {
  const client = activeClients.get(userId);
  if (client) {
    try {
      await client.disconnect();
    } catch (_) {}
    activeClients.delete(userId);
    logger.info(`Stopped monitoring for user ${userId}`);
  }

  await storage.updateUser(userId, u => ({
    ...u,
    settings: { ...u.settings, alertsEnabled: false },
  }));
}

async function isClientActive(userId) {
  const client = activeClients.get(userId);
  if (!client) return false;
  try {
    return client.connected;
  } catch (_) {
    return false;
  }
}

function getActiveClientCount() {
  return activeClients.size;
}

function getActiveUserIds() {
  return [...activeClients.keys()];
}

// ─── Login Flow: Create New Session ───────────────────────────────────────
async function createLoginSession(apiId, apiHash, phoneNumber, userId) {
  const client = new TelegramClient(new StringSession(''), parseInt(apiId), apiHash, {
    connectionRetries: 3,
  });

  await client.connect();

  // Store client temporarily for OTP step
  activeClients.set(`login_${userId}`, client);

  const result = await client.sendCode({ apiId: parseInt(apiId), apiHash }, phoneNumber);
  return { phoneCodeHash: result.phoneCodeHash, client };
}

async function completeLogin(userId, phoneNumber, phoneCode, phoneCodeHash, password = null) {
  const client = activeClients.get(`login_${userId}`);
  if (!client) throw new Error('Login session expired');

  try {
    await client.invoke(new Api.auth.SignIn({
      phoneNumber,
      phoneCodeHash,
      phoneCode,
    }));
  } catch (err) {
    // Handle 2FA
    if (err.errorMessage === 'SESSION_PASSWORD_NEEDED') {
      if (!password) throw new Error('2FA_REQUIRED');
      const { computeCheck } = require('telegram/Password');
      const passwordData = await client.invoke(new Api.account.GetPassword());
      const check = await computeCheck(passwordData, password);
      await client.invoke(new Api.auth.CheckPassword({ password: check }));
    } else {
      throw err;
    }
  }

  const session = client.session.save();
  activeClients.delete(`login_${userId}`);
  await client.disconnect();

  return session;
}

async function cancelLoginSession(userId) {
  const client = activeClients.get(`login_${userId}`);
  if (client) {
    try { await client.disconnect(); } catch (_) {}
    activeClients.delete(`login_${userId}`);
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────
async function getSenderName(client, fromId) {
  if (!fromId) return 'Unknown';
  try {
    const entity = await client.getEntity(fromId);
    return entity.username
      ? `@${entity.username}`
      : [entity.firstName, entity.lastName].filter(Boolean).join(' ') || 'Unknown';
  } catch (_) {
    return 'Unknown User';
  }
}

async function getGroupName(client, peerId) {
  try {
    const entity = await client.getEntity(peerId);
    return entity.title || entity.username || 'Unknown Group';
  } catch (_) {
    return 'Unknown Group';
  }
}

function truncate(str, len) {
  if (!str) return '';
  return str.length > len ? str.substring(0, len) + '...' : str;
}

function formatTime(timestamp) {
  return new Date(timestamp * 1000).toLocaleString('en-US', {
    hour: '2-digit', minute: '2-digit',
    month: 'short', day: 'numeric',
  });
}

async function incrementAlertCount(userId) {
  await storage.updateUser(userId, u => {
    const today = new Date().toDateString();
    const count = u.alertCount || { total: 0, today: 0, lastResetDate: today };
    if (count.lastResetDate !== today) {
      count.today = 0;
      count.lastResetDate = today;
    }
    return { ...u, alertCount: { total: count.total + 1, today: count.today + 1, lastResetDate: count.lastResetDate } };
  });
}

// ─── Restore All Active Sessions on Startup ────────────────────────────────
async function restoreAllSessions(onAlert) {
  const users = await storage.getAllUsers();
  let restored = 0;

  for (const user of users) {
    if (!user.session || !user.settings?.alertsEnabled || user.status?.banned) continue;
    try {
      await startMonitoring(user.id, onAlert);
      restored++;
      logger.info(`Restored session for user ${user.id}`);
    } catch (err) {
      logger.warn(`Failed to restore session for ${user.id}: ${err.message}`);
      // Clear invalid session
      await storage.updateUser(user.id, u => ({
        ...u, settings: { ...u.settings, alertsEnabled: false }
      }));
    }
    // Small delay between restores to avoid flooding
    await new Promise(r => setTimeout(r, 500));
  }

  logger.info(`Restored ${restored}/${users.length} monitoring sessions`);
  return restored;
}

module.exports = {
  startMonitoring,
  stopMonitoring,
  isClientActive,
  getActiveClientCount,
  getActiveUserIds,
  getClientForUser,
  createLoginSession,
  completeLogin,
  cancelLoginSession,
  restoreAllSessions,
};
// Exposed for bio verification service
function getClientForUser(userId) {
  return activeClients.get(userId) || activeClients.get(String(userId)) || null;
}
