/**
 * whatsapp/manager.js - Baileys WhatsApp connection manager
 * Handles personal WA sessions per user + optional admin sender session
 */

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs').promises;
const logger = require('../utils/logger');
const storage = require('../utils/storage');

// Map of userId → Baileys socket
const activeSockets = new Map();
// Map of userId → QR string (for regeneration)
const pendingQRs = new Map();
// Map of userId → onQR callback
const qrCallbacks = new Map();
// Map of userId → onConnected callback
const connectedCallbacks = new Map();

// ─── Start Personal WA Session ─────────────────────────────────────────────
// Track which users are in "pending QR" state (not yet connected)
const pendingConnections = new Map(); // userId → { sock, cancelled }

async function cancelPendingConnection(userId) {
  const pending = pendingConnections.get(userId);
  if (pending) {
    pending.cancelled = true;
    try { pending.sock.end(); } catch (_) {}
    pendingConnections.delete(userId);
    logger.info(`WA pending connection cancelled for ${userId}`);
  }
  // Also clear stored callbacks so reconnect loop won't fire QR
  qrCallbacks.delete(userId);
  activeSockets.delete(userId);
  pendingQRs.delete(userId);
}

async function startPersonalSession(userId, onQR, onConnected, onDisconnected) {
  // Cancel any existing pending (un-scanned) connection first
  if (pendingConnections.has(userId)) {
    logger.warn(`WA: cancelling old pending session for ${userId} before new one`);
    await cancelPendingConnection(userId);
  }
  if (activeSockets.has(userId)) {
    logger.warn(`WA socket already active for user ${userId}`);
    return;
  }

  const authDir = path.join(storage.PATHS.whatsapp, String(userId));
  await fs.mkdir(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: { level: 'silent', child: () => ({ level: 'silent', child: () => ({}), info: () => {}, error: () => {}, warn: () => {}, debug: () => {}, trace: () => {} }), info: () => {}, error: () => {}, warn: () => {}, debug: () => {}, trace: () => {} },
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
    markOnlineOnConnect: false,
    browser: ['Chrome (Linux)', 'Chrome', '120.0.0'],
    // QR timeout — stop after 3 minutes if not scanned
    qrTimeout: 180,
  });

  // Track as pending (not yet connected)
  const connectionState = { sock, cancelled: false, qrCount: 0 };
  pendingConnections.set(userId, connectionState);

  // Store callbacks
  if (onQR) qrCallbacks.set(userId, onQR);
  if (onConnected) connectedCallbacks.set(userId, onConnected);

  // ── QR Code Event ──────────────────────────────────────────────────────
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // If cancelled, stop everything
    if (connectionState.cancelled) return;

    if (qr) {
      connectionState.qrCount++;

      // Send QR only once — first time only
      // After 1st QR, user must cancel and retry if they want a new one
      if (connectionState.qrCount > 1) {
        logger.debug(`QR #${connectionState.qrCount} for ${userId} — suppressed (already sent 1)`);
        return;
      }

      pendingQRs.set(userId, qr);
      const qrImage = await generateQRImage(qr);
      const cb = qrCallbacks.get(userId);
      if (cb) await cb(qrImage, qr).catch(() => {});
      logger.info(`QR sent for user ${userId}`);
    }

    if (connection === 'open') {
      logger.info(`WhatsApp connected for user ${userId}`);

      // Move from pending to active
      pendingConnections.delete(userId);
      pendingQRs.delete(userId);
      qrCallbacks.delete(userId);

      const number = sock.user?.id?.split(':')[0] || sock.user?.id?.split('@')[0];

      if (userId !== 'admin') {
        await storage.updateUser(userId, u => ({
          ...u,
          whatsapp: { ...u.whatsapp, connected: true, number, mode: 'personal' },
        })).catch(() => {});
      }

      activeSockets.set(userId, sock);

      const cb = connectedCallbacks.get(userId);
      if (cb) await cb(number).catch(() => {});
    }

    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode;
      const isLoggedOut = reason === DisconnectReason.loggedOut;

      logger.warn(`WA disconnected for user ${userId}, reason: ${reason}`);

      pendingConnections.delete(userId);
      activeSockets.delete(userId);

      if (isLoggedOut) {
        // Permanent logout — clear session, notify
        await clearSession(userId).catch(() => {});
        if (onDisconnected && !connectionState.cancelled) {
          await onDisconnected('logged_out').catch(() => {});
        }
      } else if (!connectionState.cancelled) {
        // Transient disconnect (network etc) — reconnect silently WITHOUT QR
        // Do NOT pass onQR — this prevents 500 QR spam
        logger.info(`WA reconnecting silently for ${userId}...`);
        setTimeout(() => {
          if (!activeSockets.has(userId) && !connectionState.cancelled) {
            startPersonalSession(userId, null, onConnected, onDisconnected);
          }
        }, 8000);
      }
    }
  });

  // ── QR Timeout — auto-cancel after 3 minutes if never scanned ─────────
  setTimeout(async () => {
    if (pendingConnections.has(userId) && !connectionState.cancelled) {
      logger.info(`QR timeout for ${userId} — cancelling pending connection`);
      await cancelPendingConnection(userId);
    }
  }, 3 * 60 * 1000);

  // ── Save Credentials on Update ─────────────────────────────────────────
  sock.ev.on('creds.update', saveCreds);

  activeSockets.set(userId, sock);
  return sock;
}

// ─── Admin Session (single shared sender) ──────────────────────────────────
async function startAdminSession(onQR, onConnected) {
  return startPersonalSession('admin', onQR, onConnected, null);
}

// ─── Send Message (personal session) ──────────────────────────────────────
async function sendMessage(userId, jid, text) {
  const sock = activeSockets.get(userId);
  if (!sock) throw new Error(`No active WA socket for user ${userId}`);

  await sock.sendMessage(jid, { text: stripMarkdown(text) });
}

// ─── Send Message (admin session) ─────────────────────────────────────────
async function sendMessageAsAdmin(jid, text) {
  const sock = activeSockets.get('admin');
  if (!sock) throw new Error('Admin WA socket not active');

  await sock.sendMessage(jid, { text: stripMarkdown(text) });
}

// ─── Generate QR as PNG Buffer ─────────────────────────────────────────────
async function generateQRImage(qrString) {
  try {
    const buffer = await QRCode.toBuffer(qrString, {
      type: 'png',
      width: 300,
      margin: 2,
      color: { dark: '#000000', light: '#FFFFFF' },
    });
    return buffer;
  } catch (err) {
    logger.error(`QR generation failed: ${err.message}`);
    return null;
  }
}

// ─── Disconnect Personal Session ───────────────────────────────────────────
async function disconnectSession(userId) {
  const sock = activeSockets.get(userId);
  if (sock) {
    try {
      await sock.logout();
    } catch (_) {}
    activeSockets.delete(userId);
  }

  await clearSession(userId);

  await storage.updateUser(userId, u => ({
    ...u,
    whatsapp: { ...u.whatsapp, connected: false, number: null },
  }));

  logger.info(`WA session disconnected for user ${userId}`);
}

// ─── Clear Auth Files ──────────────────────────────────────────────────────
async function clearSession(userId) {
  const authDir = path.join(storage.PATHS.whatsapp, String(userId));
  try {
    await fs.rm(authDir, { recursive: true, force: true });
    logger.debug(`Cleared WA auth for user ${userId}`);
  } catch (_) {}
}

// ─── Restore All Personal Sessions on Startup ──────────────────────────────
async function restoreAllSessions(bot) {
  const users = await storage.getAllUsers();
  let restored = 0;

  for (const user of users) {
    if (!user.whatsapp?.connected || user.whatsapp?.mode !== 'personal') continue;
    try {
      await startPersonalSession(
        user.id,
        null, // No QR callback on restore (already connected)
        async (number) => {
          logger.info(`WA session restored for ${user.id} → ${number}`);
        },
        async (reason) => {
          if (reason === 'logged_out') {
            await storage.updateUser(user.id, u => ({
              ...u, whatsapp: { ...u.whatsapp, connected: false }
            }));
          }
        }
      );
      restored++;
    } catch (err) {
      logger.warn(`Failed to restore WA for ${user.id}: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 1000));
  }

  logger.info(`Restored ${restored} WhatsApp sessions`);
}

// ─── Check If Session Active ───────────────────────────────────────────────
function isSessionActive(userId) {
  return activeSockets.has(userId);
}

function getActiveSessionCount() {
  return activeSockets.size;
}

// ─── Strip Telegram Markdown for WA ───────────────────────────────────────
function stripMarkdown(text) {
  return text
    .replace(/\*([^*]+)\*/g, '$1')   // *bold* → plain
    .replace(/_([^_]+)_/g, '$1')     // _italic_ → plain
    .replace(/`([^`]+)`/g, '$1')     // `code` → plain
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'); // [text](url) → text
}

// ─── Regenerate QR ────────────────────────────────────────────────────────
async function regenQR(userId) {
  // Disconnect existing and restart
  const sock = activeSockets.get(userId);
  if (sock) {
    try { await sock.ws.close(); } catch (_) {}
    activeSockets.delete(userId);
  }
}

// ─── Check if Admin WA session is connected ───────────────────────────────
function isAdminConnected() {
  const adminSock = activeSockets.get('admin');
  return !!adminSock;
}

// ─── Send message to a user's WA number via Admin WA ─────────────────────
async function sendToUserWA(waNumber, message) {
  const adminSock = activeSockets.get('admin');
  if (!adminSock) throw new Error('Admin WhatsApp not connected');
  const cleaned = waNumber.replace(/[^0-9]/g, '');
  const jid = `${cleaned}@s.whatsapp.net`;
  await adminSock.sendMessage(jid, { text: message });
}

module.exports = {
  startAdminSession,
  startPersonalSession,
  cancelPendingConnection,
  sendMessage,
  sendMessageAsAdmin,
  disconnectSession,
  restoreAllSessions,
  isSessionActive,
  getActiveSessionCount,
  regenQR,
  isAdminConnected,
  sendToUserWA,
};
