/**
 * whatsapp/manager.js — Baileys WA Session Manager
 * Fixed: QR loop, duplicate sessions, proper cancel
 */

'use strict';

const path = require('path');
const fs   = require('fs').promises;
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
} = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const logger  = require('../utils/logger');
const storage = require('../utils/storage');

// userId → active connected socket
const activeSockets = new Map();

// userId → { sock, cancelled, qrSent }  — sockets that are pending QR scan
const pendingSockets = new Map();

// ─── Generate QR PNG Buffer ────────────────────────────────────────────────
async function generateQRImage(qrString) {
  return QRCode.toBuffer(qrString, {
    type: 'png',
    width: 512,
    margin: 2,
    color: { dark: '#000000', light: '#ffffff' },
  });
}

// ─── Cancel any pending (un-scanned) connection ───────────────────────────
async function cancelPendingConnection(userId) {
  const p = pendingSockets.get(userId);
  if (p) {
    p.cancelled = true;
    try { p.sock.end(); } catch (_) {}
    pendingSockets.delete(userId);
    logger.info(`WA pending cancelled for ${userId}`);
  }
}

// ─── Start WA Session ─────────────────────────────────────────────────────
// onQR(buffer)     — called ONCE with QR image
// onConnected(num) — called when scan succeeds
// onDisconnected   — called on logout
async function startPersonalSession(userId, onQR, onConnected, onDisconnected) {
  // Already fully connected — skip
  if (activeSockets.has(userId)) {
    logger.warn(`WA already active for ${userId}`);
    return;
  }

  // Cancel stale pending before starting fresh
  await cancelPendingConnection(userId);

  const authDir = path.join(storage.PATHS.whatsapp, String(userId));
  await fs.mkdir(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version }          = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: {
      level: 'silent',
      child: () => ({ level:'silent', child:()=>({}), info:()=>{}, error:()=>{}, warn:()=>{}, debug:()=>{}, trace:()=>{} }),
      info:()=>{}, error:()=>{}, warn:()=>{}, debug:()=>{}, trace:()=>{},
    },
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
    markOnlineOnConnect: false,
    browser: ['Chrome (Linux)', 'Chrome', '120.0.0'],
  });

  const pending = { sock, cancelled: false, qrSent: false };
  pendingSockets.set(userId, pending);

  // 3-minute timeout: if QR not scanned, auto-cancel
  const qrTimeout = setTimeout(async () => {
    if (pendingSockets.has(userId)) {
      logger.info(`QR timeout for ${userId}`);
      await cancelPendingConnection(userId);
    }
  }, 3 * 60 * 1000);

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    if (pending.cancelled) return;

    const { connection, lastDisconnect, qr } = update;

    // ── QR received — send ONCE only ───────────────────────────────────
    if (qr && !pending.qrSent) {
      pending.qrSent = true;
      try {
        const buf = await generateQRImage(qr);
        if (onQR) await onQR(buf);
        logger.info(`QR sent to ${userId}`);
      } catch (e) {
        logger.error(`QR send failed for ${userId}: ${e.message}`);
      }
    }

    // ── Connected ──────────────────────────────────────────────────────
    if (connection === 'open') {
      clearTimeout(qrTimeout);
      pendingSockets.delete(userId);
      activeSockets.set(userId, sock);

      const number = sock.user?.id?.split(':')[0] || sock.user?.id?.split('@')[0] || '';

      if (userId !== 'admin') {
        await storage.updateUser(userId, u => ({
          ...u,
          whatsapp: { connected: true, number },
        })).catch(() => {});
      }

      logger.info(`WA connected for ${userId} (${number})`);
      if (onConnected) await onConnected(number).catch(() => {});
    }

    // ── Disconnected ───────────────────────────────────────────────────
    if (connection === 'close') {
      clearTimeout(qrTimeout);
      pendingSockets.delete(userId);
      activeSockets.delete(userId);

      const code       = lastDisconnect?.error?.output?.statusCode;
      const loggedOut  = code === DisconnectReason.loggedOut;

      logger.warn(`WA closed for ${userId}, code=${code}`);

      if (loggedOut) {
        await clearSession(userId).catch(() => {});
        if (onDisconnected && !pending.cancelled) {
          await onDisconnected('logged_out').catch(() => {});
        }
      } else if (!pending.cancelled) {
        // Silent reconnect — NO QR, just restore session
        logger.info(`WA silent reconnect for ${userId} in 8s`);
        setTimeout(() => {
          if (!activeSockets.has(userId)) {
            startPersonalSession(userId, null, onConnected, onDisconnected);
          }
        }, 8000);
      }
    }
  });
}

// ─── Admin WA Session ─────────────────────────────────────────────────────
async function startAdminSession(onQR, onConnected) {
  return startPersonalSession('admin', onQR, onConnected, async (reason) => {
    if (reason === 'logged_out') {
      logger.warn('Admin WA logged out');
      // Auto restart so admin can reconnect
      setTimeout(() => startAdminSession(null, onConnected), 3000);
    }
  });
}

// ─── Send message via Admin WA to any number ──────────────────────────────
async function sendToUserWA(waNumber, message) {
  const sock = activeSockets.get('admin');
  if (!sock) throw new Error('Admin WhatsApp not connected');
  const jid = `${waNumber.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
  await sock.sendMessage(jid, { text: message });
}

// ─── Send via any user's personal WA socket ───────────────────────────────
async function sendMessage(userId, jid, message) {
  const sock = activeSockets.get(userId) || activeSockets.get(String(userId));
  if (!sock) throw new Error(`No active WA socket for ${userId}`);
  await sock.sendMessage(jid, { text: message });
}

// Legacy alias
async function sendMessageAsAdmin(jid, message) {
  return sendToUserWA(jid.replace('@s.whatsapp.net', ''), message);
}

// ─── Disconnect a session ─────────────────────────────────────────────────
async function disconnectSession(userId) {
  await cancelPendingConnection(userId);
  const sock = activeSockets.get(userId);
  if (sock) {
    try { await sock.logout(); } catch (_) { try { sock.end(); } catch (_) {} }
    activeSockets.delete(userId);
  }
  await clearSession(userId);
  if (userId !== 'admin') {
    await storage.updateUser(userId, u => ({
      ...u,
      whatsapp: { connected: false, number: null },
    })).catch(() => {});
  }
  logger.info(`WA disconnected for ${userId}`);
}

// ─── Clear saved auth files ───────────────────────────────────────────────
async function clearSession(userId) {
  try {
    const dir = path.join(storage.PATHS.whatsapp, String(userId));
    const files = await fs.readdir(dir);
    await Promise.all(files.map(f => fs.unlink(path.join(dir, f)).catch(() => {})));
  } catch (_) {}
}

// ─── Restore all sessions on boot ─────────────────────────────────────────
async function restoreAllSessions() {
  try {
    const users = await storage.getAllUsers();
    let count = 0;
    for (const user of users) {
      if (user.whatsapp?.connected) {
        await startPersonalSession(user.id, null, null, null);
        count++;
        await new Promise(r => setTimeout(r, 800));
      }
    }
    // Restore admin session
    const adminDir = path.join(storage.PATHS.whatsapp, 'admin');
    try {
      await fs.access(adminDir);
      await startAdminSession(null, null);
    } catch (_) {}
    logger.info(`WA: restored ${count} user sessions`);
  } catch (err) {
    logger.error(`restoreAllSessions failed: ${err.message}`);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────
function isSessionActive(userId) {
  return activeSockets.has(userId) || activeSockets.has(String(userId));
}
function isAdminConnected() {
  return activeSockets.has('admin');
}
function getActiveSessionCount() {
  return activeSockets.size;
}
async function regenQR(userId) {
  await cancelPendingConnection(userId);
  activeSockets.delete(userId);
}

module.exports = {
  startPersonalSession,
  startAdminSession,
  cancelPendingConnection,
  sendMessage,
  sendMessageAsAdmin,
  sendToUserWA,
  disconnectSession,
  restoreAllSessions,
  isSessionActive,
  isAdminConnected,
  getActiveSessionCount,
  regenQR,
};
