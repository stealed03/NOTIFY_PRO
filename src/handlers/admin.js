/**
 * handlers/admin.js - Admin panel handler
 * Handles all admin-only commands, stats, user management, broadcast, settings
 */

const logger = require('../utils/logger');
const storage = require('../utils/storage');
const gramjs = require('../gramjs/client');
const waManager = require('../whatsapp/manager');
const keyboards = require('../bot/keyboards');
const path = require('path');
const fs = require('fs').promises;

// ─── Permission Guard ──────────────────────────────────────────────────────
// Runtime admins — cleared on restart (use ADMIN_IDS env for permanent)
const runtimeAdmins = new Set();

function getAdminIds() {
  return (process.env.ADMIN_IDS || '')
    .split(',')
    .map(id => parseInt(id.trim()))
    .filter(Boolean);
}

function isAdmin(userId) {
  return getAdminIds().includes(parseInt(userId)) || runtimeAdmins.has(parseInt(userId));
}

function addRuntimeAdmin(userId) {
  runtimeAdmins.add(parseInt(userId));
  logger.info(`Runtime admin added: ${userId}`);
}

async function requireAdmin(ctx, next) {
  if (!isAdmin(ctx.from?.id)) {
    await ctx.reply('🚫 Access denied. Admin only.');
    return;
  }
  return next();
}

// ─── Admin Panel Main ──────────────────────────────────────────────────────
async function showAdminPanel(ctx) {
  const userCount = await storage.getUserCount();
  const activeClients = gramjs.getActiveClientCount();
  const waClients = waManager.getActiveSessionCount();
  const settings = await storage.getSettings();
  const maintenance = settings.features?.maintenanceMode ? '🚧 MAINTENANCE ON' : '✅ Running';

  const text =
    `🛡️ *Admin Control Panel*\n\n` +
    `👥 Total Users: *${userCount}*\n` +
    `📡 Active TG Sessions: *${activeClients}*\n` +
    `📱 Active WA Sessions: *${waClients}*\n` +
    `🔧 Status: *${maintenance}*`;

  const opts = {
    parse_mode: 'Markdown',
    reply_markup: keyboards.adminMenu().reply_markup,
  };

  // Works from both /admin command (reply) and callback_query (editMessageText)
  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, opts);
  } else {
    await ctx.reply(text, opts);
  }
}

// ─── User Stats ────────────────────────────────────────────────────────────
async function showTotalUsers(ctx) {
  const users = await storage.getAllUsers();
  const active = users.filter(u => u.settings?.alertsEnabled).length;
  const banned = users.filter(u => u.status?.banned).length;
  const premium = users.filter(u => u.premium?.active).length;

  await ctx.editMessageText(
    `👥 *User Statistics*\n\n` +
    `📊 Total: *${users.length}*\n` +
    `🟢 Alerts Active: *${active}*\n` +
    `🚫 Banned: *${banned}*\n` +
    `💎 Premium: *${premium}*`,
    {
      parse_mode: 'Markdown',
      reply_markup: keyboards.confirmMenu('admin_panel', 'admin_panel', '🔙 Back', '🔙 Back').reply_markup,
    }
  );
}

// ─── System Stats ──────────────────────────────────────────────────────────
async function showSystemStats(ctx) {
  const mem = process.memoryUsage();
  const uptime = Math.floor(process.uptime());
  const hours = Math.floor(uptime / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);

  await ctx.editMessageText(
    `📊 *System Statistics*\n\n` +
    `⏱️ Uptime: *${hours}h ${minutes}m*\n` +
    `💾 Memory: *${Math.round(mem.heapUsed / 1024 / 1024)}MB used*\n` +
    `📡 TG Clients: *${gramjs.getActiveClientCount()}*\n` +
    `📱 WA Clients: *${waManager.getActiveSessionCount()}*\n` +
    `🖥️ Node.js: *${process.version}*\n` +
    `🔧 Platform: *${process.platform}*`,
    {
      parse_mode: 'Markdown',
      reply_markup: keyboards.confirmMenu('admin_panel', 'admin_panel', '🔙 Back', '🔙 Back').reply_markup,
    }
  );
}

// ─── User Management ──────────────────────────────────────────────────────
async function showUserManagement(ctx) {
  await ctx.editMessageText(
    '👤 *User Management*\n\nSend me the *User ID* to manage:',
    {
      parse_mode: 'Markdown',
      reply_markup: keyboards.cancelButton('admin_panel').reply_markup,
    }
  );
  // State for next message
  ctx.session = { ...ctx.session, adminAction: 'user_lookup' };
}

async function handleUserLookup(ctx, userId) {
  const target = await storage.getUser(userId);
  if (!target) {
    await ctx.reply(`❌ User ${userId} not found.`);
    return;
  }

  await ctx.reply(
    `👤 *User: ${userId}*\n\n` +
    `Username: @${target.telegram?.username || 'N/A'}\n` +
    `Name: ${target.telegram?.firstName || ''} ${target.telegram?.lastName || ''}\n` +
    `Phone: ${target.telegram?.phone || 'N/A'}\n` +
    `Session: ${target.session ? '✅ Active' : '❌ None'}\n` +
    `Alerts: ${target.settings?.alertsEnabled ? '🟢 ON' : '🔴 OFF'}\n` +
    `WA: ${target.whatsapp?.connected ? '✅ Connected' : '❌ Not connected'}\n` +
    `Premium: ${target.premium?.active ? '💎 Yes' : '❌ No'}\n` +
    `Banned: ${target.status?.banned ? '🚫 Yes' : '✅ No'}\n` +
    `Joined: ${target.status?.joinedAt?.split('T')[0] || 'N/A'}\n` +
    `Alerts sent: ${target.alertCount?.total || 0}`,
    {
      parse_mode: 'Markdown',
      reply_markup: keyboards.adminUserMenu(userId).reply_markup,
    }
  );
}

async function banUser(ctx, targetId) {
  const target = await storage.getUser(targetId);
  if (!target) { await ctx.reply('❌ User not found'); return; }

  await gramjs.stopMonitoring(targetId);
  await storage.updateUser(targetId, u => ({
    ...u,
    status: { ...u.status, banned: true, banReason: 'Admin ban' },
  }));

  await ctx.reply(`✅ User ${targetId} has been banned.`);
  logger.info(`Admin banned user ${targetId}`);
}

async function unbanUser(ctx, targetId) {
  await storage.updateUser(targetId, u => ({
    ...u,
    status: { ...u.status, banned: false, banReason: null },
  }));
  await ctx.reply(`✅ User ${targetId} has been unbanned.`);
}

async function deleteUser(ctx, targetId) {
  await gramjs.stopMonitoring(targetId);
  await waManager.disconnectSession(targetId).catch(() => {});

  const filePath = path.join(storage.PATHS.users, `${targetId}.json`);
  await fs.unlink(filePath).catch(() => {});

  await ctx.reply(`🗑️ User ${targetId} deleted.`);
  logger.info(`Admin deleted user ${targetId}`);
}

async function forceLogoutUser(ctx, targetId) {
  await gramjs.stopMonitoring(targetId);
  await storage.updateUser(targetId, u => ({
    ...u,
    session: null,
    settings: { ...u.settings, alertsEnabled: false },
    status: { ...u.status, loginState: 'idle', loginData: {} },
  }));

  // Notify user
  try {
    await ctx.telegram.sendMessage(targetId, '⚠️ You have been logged out by an administrator.');
  } catch (_) {}

  await ctx.reply(`✅ User ${targetId} force logged out.`);
}

async function forceVerifyUser(ctx, targetId) {
  await storage.updateUser(targetId, u => ({
    ...u,
    verification: { ...u.verification, status: true, bypassed: true, lastChecked: new Date().toISOString() },
  }));
  await ctx.reply(`✅ User ${targetId} force verified.`);
}

async function setPremium(ctx, targetId) {
  await storage.updateUser(targetId, u => ({
    ...u,
    premium: { active: true, expiresAt: null },
  }));
  try {
    await ctx.telegram.sendMessage(targetId, '💎 You have been granted premium access!');
  } catch (_) {}
  await ctx.reply(`✅ Premium granted to ${targetId}.`);
}

// ─── Broadcast System ──────────────────────────────────────────────────────
const pendingBroadcasts = new Map();

async function startBroadcast(ctx) {
  await ctx.editMessageText(
    '📢 *Broadcast Message*\n\n' +
    'Send the message you want to broadcast to all users.\n' +
    'Supports: text, photos, videos, documents.\n\n' +
    '_Send /cancel to abort_',
    { parse_mode: 'Markdown' }
  );
  pendingBroadcasts.set(ctx.from.id, { step: 'awaiting_message' });
}

async function handleBroadcastMessage(ctx) {
  const adminId = ctx.from.id;
  const pending = pendingBroadcasts.get(adminId);
  if (!pending || pending.step !== 'awaiting_message') return false;

  pending.message = ctx.message;
  pending.step = 'confirm';
  pendingBroadcasts.set(adminId, pending);

  const users = await storage.getAllUsers();
  const activeUsers = users.filter(u => !u.status?.banned);

  await ctx.reply(
    `📢 *Broadcast Preview*\n\n` +
    `Recipients: *${activeUsers.length} users*\n\n` +
    `Ready to send?`,
    {
      parse_mode: 'Markdown',
      reply_markup: keyboards.broadcastConfirmMenu().reply_markup,
    }
  );
  return true;
}

async function executeBroadcast(ctx) {
  const adminId = ctx.from.id;
  const pending = pendingBroadcasts.get(adminId);
  if (!pending) return;

  pendingBroadcasts.delete(adminId);

  const users = await storage.getAllUsers();
  const targets = users.filter(u => !u.status?.banned);

  const progressMsg = await ctx.reply(`📢 Broadcasting to ${targets.length} users...`);
  let sent = 0, failed = 0;

  const delay = (ms) => new Promise(r => setTimeout(r, ms));
  const settings = await storage.getSettings();
  const delayMs = settings.broadcast?.delayBetweenMessages || 100;

  for (const user of targets) {
    try {
      const msg = pending.message;
      if (msg.text) {
        await ctx.telegram.sendMessage(user.id, msg.text, { parse_mode: 'Markdown' });
      } else if (msg.photo) {
        const photo = msg.photo[msg.photo.length - 1].file_id;
        await ctx.telegram.sendPhoto(user.id, photo, { caption: msg.caption || '' });
      } else if (msg.video) {
        await ctx.telegram.sendVideo(user.id, msg.video.file_id, { caption: msg.caption || '' });
      } else if (msg.document) {
        await ctx.telegram.sendDocument(user.id, msg.document.file_id, { caption: msg.caption || '' });
      }
      sent++;
    } catch (err) {
      failed++;
      if (err.message?.includes('Too Many Requests')) {
        // FloodWait - extract wait time and pause
        const wait = parseInt(err.message.match(/retry after (\d+)/i)?.[1] || '5');
        logger.warn(`Broadcast floodwait: ${wait}s`);
        await delay(wait * 1000);
      }
    }
    await delay(delayMs);
  }

  await ctx.telegram.editMessageText(
    ctx.chat.id,
    progressMsg.message_id,
    null,
    `📢 *Broadcast Complete*\n\n✅ Sent: ${sent}\n❌ Failed: ${failed}`,
    { parse_mode: 'Markdown' }
  );

  logger.info(`Broadcast complete: ${sent} sent, ${failed} failed`);
}

// ─── System Settings ───────────────────────────────────────────────────────
async function showSystemSettings(ctx) {
  const settings = await storage.getSettings();
  await ctx.editMessageText(
    '⚙️ *System Settings*\n\nToggle features and change system configuration:',
    {
      parse_mode: 'Markdown',
      reply_markup: keyboards.adminSettingsMenu(settings).reply_markup,
    }
  );
}

async function toggleFeature(ctx, featureKey) {
  const settings = await storage.getSettings();
  const current = settings.features[featureKey];
  await storage.updateSettings(s => ({
    ...s,
    features: { ...s.features, [featureKey]: !current },
  }));
  await ctx.answerCbQuery(`${featureKey}: ${!current ? 'ON ✅' : 'OFF ❌'}`);
  await showSystemSettings(ctx);
}

async function promptChangeText(ctx, field, label) {
  await ctx.editMessageText(
    `✏️ *Change ${label}*\n\nSend the new value:`,
    { parse_mode: 'Markdown', reply_markup: keyboards.cancelButton('admin_settings').reply_markup }
  );
  // Store what we're changing
  ctx.session = { ...ctx.session, adminTextChange: field };
}

async function applyTextChange(ctx, field, value) {
  const fieldMap = {
    support:   ['bot', 'supportUsername'],
    welcome:   ['bot', 'welcomeMessage'],
    biotext:   ['bioVerification', 'requiredText'],
    footer:    ['bot', 'footerText'],
    botuser:   ['bot', 'botUsername'],
    adminuser: ['bot', 'adminUsername'],
    greeting:  ['bot', 'greetingMessage'],
    confirm:   ['bot', 'confirmationMessage'],
  };

  const [section, key] = fieldMap[field] || [];
  if (!section) return;

  await storage.updateSettings(s => ({
    ...s,
    [section]: { ...s[section], [key]: value },
  }));

  await ctx.reply(`✅ ${field} updated successfully.`, {
    reply_markup: keyboards.adminMenu().reply_markup,
  });
}

// ─── Force Join Settings ───────────────────────────────────────────────────
async function showForceJoinSettings(ctx) {
  const settings = await storage.getSettings();
  const channels = settings.forceJoin?.channels || [];

  const channelList = channels.length > 0
    ? channels.map((ch, i) => `${i + 1}. ${ch.name || ch.id}`).join('\n')
    : '_No channels added_';

  await ctx.editMessageText(
    `🔗 *Force Join Settings*\n\n` +
    `Status: ${settings.features?.forceJoin ? '✅ Enabled' : '❌ Disabled'}\n\n` +
    `Channels:\n${channelList}`,
    {
      parse_mode: 'Markdown',
      reply_markup: keyboards.adminMenu().reply_markup,
    }
  );
}

// ─── Bio Verification Settings ─────────────────────────────────────────────
async function showBioVerifySettings(ctx) {
  const settings = await storage.getSettings();
  const bv = settings.bioVerification;

  await ctx.editMessageText(
    `✅ *Bio Verification Settings*\n\n` +
    `Status: ${settings.features?.bioVerification ? '✅ Enabled' : '❌ Disabled'}\n` +
    `Required Text: \`${bv?.requiredText || 'Not set'}\`\n` +
    `Recheck: Every ${bv?.recheckIntervalHours || 12}h\n` +
    `Premium Bypass: ${bv?.premiumBypass ? '✅' : '❌'}`,
    {
      parse_mode: 'Markdown',
      reply_markup: keyboards.adminMenu().reply_markup,
    }
  );
}

// ─── View Logs ─────────────────────────────────────────────────────────────
async function showLogs(ctx) {
  const logDir = path.join(process.cwd(), 'data/logs');
  try {
    const errorLog = path.join(logDir, 'errors.log');
    const content = await fs.readFile(errorLog, 'utf8');
    const lines = content.trim().split('\n').slice(-20); // Last 20 lines

    if (lines.length === 0 || !content.trim()) {
      await ctx.reply('📋 No errors logged.');
      return;
    }

    const preview = lines.join('\n').substring(0, 3500);
    await ctx.reply(`📋 *Last Error Logs:*\n\`\`\`\n${preview}\n\`\`\``, {
      parse_mode: 'Markdown',
    });
  } catch (_) {
    await ctx.reply('📋 No error logs found.');
  }
}

module.exports = {
  isAdmin,
  requireAdmin,
  showAdminPanel,
  showTotalUsers,
  showSystemStats,
  showUserManagement,
  handleUserLookup,
  banUser,
  unbanUser,
  deleteUser,
  forceLogoutUser,
  forceVerifyUser,
  setPremium,
  startBroadcast,
  handleBroadcastMessage,
  executeBroadcast,
  showSystemSettings,
  toggleFeature,
  promptChangeText,
  applyTextChange,
  showForceJoinSettings,
  showBioVerifySettings,
  showLogs,
  pendingBroadcasts,
};
