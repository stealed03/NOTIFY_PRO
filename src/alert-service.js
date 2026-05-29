/**
 * alert-service.js - Routes alerts to the correct destination
 * Supports: Admin WhatsApp mode, Personal WhatsApp mode
 * Includes rate limiting and queue system
 */

const PQueue = require('p-queue').default || require('p-queue');
const logger = require('../utils/logger');
const storage = require('../utils/storage');
const waManager = require('../whatsapp/manager');

// Per-user rate limit tracking
const rateLimitMap = new Map(); // userId → { count, resetTime }

// Global send queue (prevents flooding)
const sendQueue = new PQueue({ concurrency: 3, interval: 1000, intervalCap: 5 });

// ─── Main Alert Handler ────────────────────────────────────────────────────
async function sendAlert(bot, userId, alertType, alertData) {
  try {
    const user = await storage.getUser(userId);
    if (!user || user.status?.banned) return;

    const settings = await storage.getSettings();

    // Rate limit check
    if (!checkRateLimit(userId, settings)) {
      logger.debug(`Alert rate limited for user ${userId}`);
      return;
    }

    // Format the alert message
    const message = formatAlert(alertType, alertData, settings);

    // Determine delivery mode
    const waMode = user.whatsapp?.mode || 'admin';
    const waConnected = user.whatsapp?.connected;

    if (waMode === 'personal' && waConnected) {
      // Personal WhatsApp mode
      await sendQueue.add(() => sendViaPersonalWhatsApp(userId, user, message));
    } else if (settings.features?.adminWhatsappMode) {
      // Admin WhatsApp mode
      await sendQueue.add(() => sendViaAdminWhatsApp(userId, user, message, settings));
    } else {
      // Fallback: send via Telegram bot
      await sendQueue.add(() => sendViaTelegram(bot, userId, message));
    }

    logger.debug(`Alert sent to ${userId} via ${waMode} mode: ${alertType}`);
  } catch (err) {
    logger.error(`Failed to send alert to ${userId}: ${err.message}`);
  }
}

// ─── Format Alert Message ──────────────────────────────────────────────────
function formatAlert(alertType, data, settings) {
  const templates = settings.alerts?.templates || {};
  let template = templates[alertType];

  if (!template) {
    // Fallback templates
    const defaults = {
      privateMessage: '📩 *New DM*\n\n👤 From: {sender}\n💬 {message}\n🕐 {time}',
      mention: '🔔 *Mentioned*\n\n👥 {groupName}\n👤 By: {sender}\n💬 {message}\n🕐 {time}',
      reply: '💬 *New Reply*\n\n💬 {chatName}\n👤 {sender}\n💬 {message}\n🕐 {time}',
    };
    template = defaults[alertType] || '🔔 New Alert: {message}';
  }

  // Replace placeholders
  let formatted = template;
  for (const [key, value] of Object.entries(data)) {
    formatted = formatted.replace(new RegExp(`{${key}}`, 'g'), value || '');
  }

  return formatted;
}

// ─── Send via Personal WhatsApp ────────────────────────────────────────────
async function sendViaPersonalWhatsApp(userId, user, message) {
  const waNumber = user.whatsapp?.number;
  if (!waNumber) {
    logger.warn(`No WA number for user ${userId}`);
    return;
  }

  try {
    const jid = `${waNumber}@s.whatsapp.net`;
    await waManager.sendMessage(userId, jid, message);
    logger.debug(`Sent personal WA alert to ${userId}`);
  } catch (err) {
    logger.error(`Personal WA send failed for ${userId}: ${err.message}`);
    // Fallback to Telegram notification about WA failure
  }
}

// ─── Send via Admin WhatsApp ───────────────────────────────────────────────
async function sendViaAdminWhatsApp(userId, user, message, settings) {
  const adminWaNumber = process.env.ADMIN_WA_NUMBER;
  if (!adminWaNumber) {
    logger.warn('Admin WA number not configured');
    return;
  }

  const waNumber = user.whatsapp?.number || user.telegram?.phone;
  if (!waNumber) {
    logger.warn(`No recipient WA number for user ${userId}`);
    return;
  }

  try {
    const jid = `${waNumber}@s.whatsapp.net`;
    await waManager.sendMessageAsAdmin(jid, message);
    logger.debug(`Sent admin WA alert to ${userId}`);
  } catch (err) {
    logger.error(`Admin WA send failed for ${userId}: ${err.message}`);
  }
}

// ─── Fallback: Send via Telegram Bot ──────────────────────────────────────
async function sendViaTelegram(bot, userId, message) {
  try {
    await bot.telegram.sendMessage(userId, message, { parse_mode: 'Markdown' });
  } catch (err) {
    logger.error(`Telegram fallback failed for ${userId}: ${err.message}`);
  }
}

// ─── Rate Limiting ─────────────────────────────────────────────────────────
function checkRateLimit(userId, settings) {
  const limits = settings.alerts?.rateLimit || { maxPerMinute: 10, maxPerHour: 100 };
  const now = Date.now();
  const windowMs = 60 * 1000; // 1 minute

  if (!rateLimitMap.has(userId)) {
    rateLimitMap.set(userId, { count: 0, resetTime: now + windowMs });
  }

  const rl = rateLimitMap.get(userId);

  if (now > rl.resetTime) {
    rl.count = 0;
    rl.resetTime = now + windowMs;
  }

  if (rl.count >= limits.maxPerMinute) {
    return false;
  }

  rl.count++;
  return true;
}

// ─── Test Alert ────────────────────────────────────────────────────────────
async function sendTestAlert(bot, userId) {
  const user = await storage.getUser(userId);
  const settings = await storage.getSettings();

  const testData = {
    sender: '@test_user',
    message: 'This is a test alert! 🎉 Your monitoring is working correctly.',
    chatLink: 'https://t.me',
    time: new Date().toLocaleString(),
    groupName: 'Test Group',
    chatName: 'Test Chat',
  };

  await sendAlert(bot, userId, 'privateMessage', testData);
}

module.exports = {
  sendAlert,
  sendTestAlert,
  formatAlert,
};
