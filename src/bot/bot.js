/**
 * bot.js - Main Telegraf bot
 * Mode A: Account Monitor | Mode B: WA Forwarder
 */

const { Telegraf, session } = require('telegraf');
const logger      = require('../utils/logger');
const storage     = require('../utils/storage');
const gramjs      = require('../gramjs/client');
const waManager   = require('../whatsapp/manager');
const alertService = require('../services/alert-service');
const verification = require('../services/verification');
const loginHandler = require('../handlers/login');
const adminHandler = require('../handlers/admin');
const helpHandler  = require('../handlers/help');
const keyboards   = require('./keyboards');

// ─── Welcome Text ──────────────────────────────────────────────────────────
function buildWelcome(user, settings) {
  const name = user?.telegram?.firstName || 'there';
  const custom = settings.bot?.welcomeMessage;
  if (custom) return custom;

  return (
    `🤖 <b>Welcome to TeleForward, ${name}!</b>\n\n` +
    `Choose how you want this bot to work for you:\n\n` +
    `🕵️ <b>Mode A — Account Monitor</b>\n` +
    `Login with your Telegram account and get real-time alerts for DMs, mentions & replies — forwarded to WhatsApp.\n\n` +
    `📲 <b>Mode B — WA Message Forwarder</b>\n` +
    `Anyone who messages this bot will be instantly forwarded to your WhatsApp. No account login needed.\n\n` +
    `👇 <b>Pick your mode below:</b>`
  );
}

// ─── Mode B welcome (after mode chosen) ───────────────────────────────────
function buildModeBWelcome(user) {
  const waConnected = user?.whatsapp?.connected;
  const forwarding  = user?.forwarder?.active;

  return (
    `📲 <b>WA Message Forwarder</b>\n\n` +
    `📦 <b>How it works:</b>\n` +
    `Anyone who sends a message to this bot → it gets forwarded instantly to your WhatsApp.\n\n` +
    `✅ <b>Status:</b>\n` +
    `📱 WhatsApp: ${waConnected ? `Connected (${user.whatsapp.number})` : 'Not connected'}\n` +
    `📡 Forwarding: ${forwarding ? '🟢 Active' : '🔴 Stopped'}\n\n` +
    (waConnected ? '' : `⚠️ Connect your WhatsApp first to start receiving messages.`)
  );
}

function buildModeAWelcome(user, settings) {
  const hasSession  = !!user?.session;
  const alertsOn    = user?.settings?.alertsEnabled;
  const waConnected = user?.whatsapp?.connected;

  return (
    `🕵️ <b>Account Monitor</b>\n\n` +
    `📦 <b>How it works:</b>\n` +
    `Login with your Telegram account. Any DMs, mentions or replies you get are forwarded to you as alerts — even to WhatsApp.\n\n` +
    `✅ <b>Status:</b>\n` +
    `🔐 Logged in: ${hasSession ? 'Yes' : 'No'}\n` +
    `📡 Monitoring: ${alertsOn ? '🟢 Active' : '🔴 Stopped'}\n` +
    `📱 WhatsApp: ${waConnected ? `Connected` : 'Not connected'}`
  );
}

// ─── Create Bot ────────────────────────────────────────────────────────────
function createBot() {
  const bot = new Telegraf(process.env.BOT_TOKEN);

  bot.use(session());

  // ── Global Middleware ──────────────────────────────────────────────────
  bot.use(async (ctx, next) => {
    if (!ctx.from) return next();
    const userId = ctx.from.id;

    await storage.createUser(userId, ctx.from);
    await storage.updateUser(userId, u => ({
      ...u,
      telegram: {
        ...u.telegram,
        username:  ctx.from.username  || u.telegram?.username,
        firstName: ctx.from.first_name || u.telegram?.firstName,
        lastName:  ctx.from.last_name  || u.telegram?.lastName,
      },
      status: { ...u.status, lastSeenAt: new Date().toISOString() },
    }));

    const user     = await storage.getUser(userId);
    const settings = await storage.getSettings();

    if (user?.status?.banned && !adminHandler.isAdmin(userId)) {
      await ctx.reply('🚫 Your account has been banned.');
      return;
    }
    if (settings.features?.maintenanceMode && !adminHandler.isAdmin(userId)) {
      await ctx.reply('🚧 Bot is under maintenance. Please try later.');
      return;
    }

    return next();
  });

  // ── /start ─────────────────────────────────────────────────────────────
  bot.command('start', async (ctx) => {
    const userId   = ctx.from.id;
    const settings = await storage.getSettings();
    const user     = await storage.getUser(userId);

    if (!(await verification.checkForceJoin(bot, userId))) {
      return verification.promptForceJoin(ctx);
    }

    // No mode set — show mode picker
    if (!user.mode) {
      await ctx.reply(buildWelcome(user, settings), {
        parse_mode: 'HTML',
        reply_markup: keyboards.modeSelectMenu().reply_markup,
      });
      return;
    }

    // Mode A
    if (user.mode === 'monitor') {
      if (settings.features?.bioVerification && user.session) {
        const verified = await verification.checkBioVerification(userId);
        if (!verified) return verification.promptVerification(ctx);
      }
      await ctx.reply(buildModeAWelcome(user, settings), {
        parse_mode: 'HTML',
        reply_markup: keyboards.mainMenuA(user, settings).reply_markup,
      });
      return;
    }

    // Mode B
    if (user.mode === 'forwarder') {
      await ctx.reply(buildModeBWelcome(user), {
        parse_mode: 'HTML',
        reply_markup: keyboards.mainMenuB(user, settings).reply_markup,
      });
      return;
    }
  });

  // ── /admin ─────────────────────────────────────────────────────────────
  bot.command('admin', async (ctx) => {
    if (!adminHandler.isAdmin(ctx.from.id)) {
      await ctx.reply('🚫 Access denied.');
      return;
    }
    await adminHandler.showAdminPanel(ctx);
  });

  // ── Text Handler ───────────────────────────────────────────────────────
  bot.on('text', async (ctx, next) => {
    const userId = ctx.from.id;
    const text   = ctx.message.text;
    if (text.startsWith('/')) return next();

    const user = await storage.getUser(userId);
    if (!user) return next();

    // Mode B: Forward incoming messages to admin WA
    if (user.mode === 'forwarder' && user.forwarder?.active) {
      await handleForwarderMessage(ctx, user, text);
      return;
    }

    // Login flow
    const loginState = user.status?.loginState;
    if (loginState && loginState !== 'idle' && loginState !== 'done') {
      const handled = await loginHandler.handleLoginStep(ctx);
      if (handled) return;
    }

    // Support ticket
    if (user.status?.supportStep === 'awaiting_message') {
      await verification.submitTicket(ctx, text);
      return;
    }

    // Admin: user lookup
    if (adminHandler.isAdmin(userId) && ctx.session?.adminAction === 'user_lookup') {
      const targetId = parseInt(text);
      if (targetId) {
        ctx.session.adminAction = null;
        await adminHandler.handleUserLookup(ctx, targetId);
        return;
      }
    }

    // Admin: broadcast
    if (adminHandler.isAdmin(userId)) {
      const handled = await adminHandler.handleBroadcastMessage(ctx);
      if (handled) return;
    }

    // Admin: text field change
    if (adminHandler.isAdmin(userId) && ctx.session?.adminTextChange) {
      const field = ctx.session.adminTextChange;
      ctx.session.adminTextChange = null;
      await adminHandler.applyTextChange(ctx, field, text);
      return;
    }

    return next();
  });

  // Mode B: handle media messages too
  bot.on(['photo', 'video', 'document', 'audio', 'voice', 'sticker'], async (ctx) => {
    const userId = ctx.from.id;
    const user   = await storage.getUser(userId);
    if (user?.mode === 'forwarder' && user?.forwarder?.active) {
      await handleForwarderMessage(ctx, user, '[Media message]');
    }
  });

  // ── Callback Handler ───────────────────────────────────────────────────
  bot.on('callback_query', async (ctx) => {
    const data   = ctx.callbackQuery.data;
    const userId = ctx.from.id;

    try {
      await ctx.answerCbQuery();

      const user     = await storage.getUser(userId);
      const settings = await storage.getSettings();

      // ── Mode Selection ─────────────────────────────────────────────
      if (data === 'mode_select_a') {
        await storage.updateUser(userId, u => ({ ...u, mode: 'monitor' }));
        const freshUser = await storage.getUser(userId);
        await ctx.editMessageText(buildModeAWelcome(freshUser, settings), {
          parse_mode: 'HTML',
          reply_markup: keyboards.mainMenuA(freshUser, settings).reply_markup,
        });
        return;
      }

      if (data === 'mode_select_b') {
        await storage.updateUser(userId, u => ({
          ...u,
          mode: 'forwarder',
          forwarder: { ...(u.forwarder || {}), active: false },
        }));
        const freshUser = await storage.getUser(userId);
        await ctx.editMessageText(buildModeBWelcome(freshUser), {
          parse_mode: 'HTML',
          reply_markup: keyboards.mainMenuB(freshUser, settings).reply_markup,
        });
        return;
      }

      if (data === 'mode_info') {
        await ctx.editMessageText(
          `🕵️ <b>Mode A — Account Monitor</b>\n` +
          `Login with your Telegram account. Bot silently monitors your DMs, mentions &amp; replies and sends you alerts — optionally forwarded to WhatsApp.\n\n` +
          `📲 <b>Mode B — WA Forwarder</b>\n` +
          `Anyone who messages THIS BOT gets forwarded to your WhatsApp. No Telegram account login needed. Perfect for business or inquiry bots.`,
          {
            parse_mode: 'HTML',
            reply_markup: keyboards.modeSelectMenu().reply_markup,
          }
        );
        return;
      }

      if (data === 'switch_mode') {
        await storage.updateUser(userId, u => ({ ...u, mode: null }));
        await ctx.editMessageText(buildWelcome(user, settings), {
          parse_mode: 'HTML',
          reply_markup: keyboards.modeSelectMenu().reply_markup,
        });
        return;
      }

      // ── Main Menu ──────────────────────────────────────────────────
      if (data === 'main_menu') {
        const freshUser = await storage.getUser(userId);
        if (freshUser.mode === 'forwarder') {
          await ctx.editMessageText(buildModeBWelcome(freshUser), {
            parse_mode: 'HTML',
            reply_markup: keyboards.mainMenuB(freshUser, settings).reply_markup,
          });
        } else if (freshUser.mode === 'monitor') {
          await ctx.editMessageText(buildModeAWelcome(freshUser, settings), {
            parse_mode: 'HTML',
            reply_markup: keyboards.mainMenuA(freshUser, settings).reply_markup,
          });
        } else {
          await ctx.editMessageText(buildWelcome(freshUser, settings), {
            parse_mode: 'HTML',
            reply_markup: keyboards.modeSelectMenu().reply_markup,
          });
        }
        return;
      }

      // ── Mode B: Forwarder Controls ─────────────────────────────────
      if (data === 'forwarder_start') {
        if (!user.whatsapp?.connected) {
          await ctx.answerCbQuery('❌ Connect WhatsApp first!', { show_alert: true });
          return;
        }
        await storage.updateUser(userId, u => ({
          ...u,
          forwarder: { ...(u.forwarder || {}), active: true, startedAt: new Date().toISOString() },
        }));
        const freshUser = await storage.getUser(userId);
        await ctx.editMessageText(buildModeBWelcome(freshUser), {
          parse_mode: 'HTML',
          reply_markup: keyboards.mainMenuB(freshUser, settings).reply_markup,
        });
        await ctx.answerCbQuery('🟢 Forwarding started!');
        return;
      }

      if (data === 'forwarder_stop') {
        await storage.updateUser(userId, u => ({
          ...u,
          forwarder: { ...(u.forwarder || {}), active: false },
        }));
        const freshUser = await storage.getUser(userId);
        await ctx.editMessageText(buildModeBWelcome(freshUser), {
          parse_mode: 'HTML',
          reply_markup: keyboards.mainMenuB(freshUser, settings).reply_markup,
        });
        await ctx.answerCbQuery('🔴 Forwarding stopped.');
        return;
      }

      if (data === 'forwarder_test') {
        if (!user.whatsapp?.connected) {
          await ctx.answerCbQuery('❌ Connect WhatsApp first!', { show_alert: true });
          return;
        }
        await sendForwardToAdminWA(
          `🧪 <b>Test Forward</b>\n\nThis is a test message from your TeleForward bot.\nUser: @${user.telegram?.username || 'Unknown'}\nTime: ${new Date().toLocaleString()}`,
          userId, user
        );
        await ctx.answerCbQuery('✅ Test sent to WhatsApp!', { show_alert: true });
        return;
      }

      if (data === 'forwarder_stats') {
        const stats = user.forwarder || {};
        await ctx.editMessageText(
          `📊 *Forwarder Stats*\n\n` +
          `📨 Total forwarded: ${stats.totalForwarded || 0}\n` +
          `📅 Today: ${stats.todayForwarded || 0}\n` +
          `🟢 Status: ${stats.active ? 'Active' : 'Stopped'}\n` +
          `📱 WA: ${user.whatsapp?.connected ? user.whatsapp.number : 'Not connected'}`,
          {
            parse_mode: 'Markdown',
            reply_markup: keyboards.mainMenuB(user, settings).reply_markup,
          }
        );
        return;
      }

      if (data === 'forwarder_howto') {
        await ctx.editMessageText(
          `📲 <b>How WA Forwarder Works</b>\n\n` +
          `1. Connect your WhatsApp using the button below\n` +
          `2. Tap <b>Start Forwarding</b>\n` +
          `3. Anyone who sends a message to this bot will have their message forwarded to your WhatsApp instantly.\n\n` +
          `✅ No Telegram account login needed!\n` +
          `✅ Works 24/7 in the background.\n` +
          `✅ Includes sender info (name, username, ID).`,
          {
            parse_mode: 'HTML',
            reply_markup: keyboards.mainMenuB(user, settings).reply_markup,
          }
        );
        return;
      }

      if (data === 'wa_status') {
        const waConnected = user.whatsapp?.connected;
        await ctx.editMessageText(
          `📱 *WhatsApp Status*\n\n` +
          `Connected: ${waConnected ? '✅ Yes' : '❌ No'}\n` +
          (waConnected ? `Number: ${user.whatsapp.number}` : ''),
          {
            parse_mode: 'Markdown',
            reply_markup: keyboards.mainMenuB(user, settings).reply_markup,
          }
        );
        return;
      }

      // ── Mode A: Monitor Controls ───────────────────────────────────
      if (data === 'login_start') {
        await loginHandler.startLogin(ctx);
        return;
      }
      if (data === 'login_cancel') {
        await loginHandler.cancelLogin(ctx);
        return;
      }

      if (data === 'logout_confirm') {
        await ctx.editMessageText(
          '🚪 *Are you sure you want to logout?*\n\nThis will stop all monitoring.',
          {
            parse_mode: 'Markdown',
            reply_markup: keyboards.confirmMenu('logout_execute', 'main_menu', '🚪 Yes, Logout', '❌ Cancel').reply_markup,
          }
        );
        return;
      }
      if (data === 'logout_execute') {
        await loginHandler.logout(ctx);
        return;
      }

      if (data === 'alerts_start') {
        if (!user.session) {
          await ctx.answerCbQuery('❌ Please login first!', { show_alert: true });
          return;
        }
        if (!(await verification.checkForceJoin(bot, userId))) {
          await verification.promptForceJoin(ctx);
          return;
        }
        if (settings.features?.bioVerification && !(await verification.checkBioVerification(userId))) {
          await verification.promptVerification(ctx);
          return;
        }

        const onAlert = async (uid, type, alertData) => {
          await alertService.sendAlert(bot, uid, type, alertData);
        };
        await gramjs.startMonitoring(userId, onAlert);

        const freshUser = await storage.getUser(userId);
        await ctx.editMessageText(buildModeAWelcome(freshUser, settings), {
          parse_mode: 'HTML',
          reply_markup: keyboards.mainMenuA(freshUser, settings).reply_markup,
        });
        await ctx.answerCbQuery('🟢 Monitoring started!');
        return;
      }

      if (data === 'alerts_stop') {
        await gramjs.stopMonitoring(userId);
        const freshUser = await storage.getUser(userId);
        await ctx.editMessageText(buildModeAWelcome(freshUser, settings), {
          parse_mode: 'HTML',
          reply_markup: keyboards.mainMenuA(freshUser, settings).reply_markup,
        });
        return;
      }

      if (data === 'test_alert') {
        await alertService.sendTestAlert(bot, userId);
        await ctx.answerCbQuery('✅ Test alert sent!', { show_alert: true });
        return;
      }

      if (data === 'alert_settings') {
        await ctx.editMessageText(
          '⚙️ *Alert Settings*\n\nToggle your preferences:',
          {
            parse_mode: 'Markdown',
            reply_markup: keyboards.alertSettingsMenu(user).reply_markup,
          }
        );
        return;
      }

      // Toggles
      const toggleMap = {
        toggle_dm:      'dmAlerts',
        toggle_mention: 'mentionAlerts',
        toggle_reply:   'replyAlerts',
        toggle_group:   'groupAlerts',
        toggle_silent:  'silentMode',
      };
      if (toggleMap[data]) {
        const key = toggleMap[data];
        await storage.updateUser(userId, u => ({
          ...u,
          settings: { ...u.settings, [key]: !u.settings?.[key] },
        }));
        const freshUser = await storage.getUser(userId);
        await ctx.editMessageReplyMarkup(keyboards.alertSettingsMenu(freshUser).reply_markup);
        return;
      }

      // WA mode switch
      if (data === 'wa_mode_admin' || data === 'wa_mode_personal') {
        const mode = data === 'wa_mode_admin' ? 'admin' : 'personal';
        if (mode === 'personal' && !user.whatsapp?.connected) {
          await ctx.answerCbQuery('❌ Connect WhatsApp first!', { show_alert: true });
          return;
        }
        await storage.updateUser(userId, u => ({
          ...u,
          whatsapp: { ...u.whatsapp, mode },
        }));
        const freshUser = await storage.getUser(userId);
        await ctx.editMessageReplyMarkup(keyboards.alertSettingsMenu(freshUser).reply_markup);
        return;
      }

      // ── WhatsApp ───────────────────────────────────────────────────
      if (data === 'wa_connect') {
        await ctx.editMessageText(
          '📱 <b>Connecting to WhatsApp...</b>\n\nGenerating QR code, please wait...',
          { parse_mode: 'HTML' }
        );
        await waManager.startPersonalSession(
          userId,
          async (qrBuffer) => {
            try {
              await ctx.telegram.sendPhoto(userId, { source: qrBuffer }, {
                caption:
                  '📱 <b>Scan this QR code with WhatsApp</b>\n\n' +
                  '1. Open WhatsApp on your phone\n' +
                  '2. Go to <b>Settings → Linked Devices → Link a Device</b>\n' +
                  '3. Scan this code\n\n' +
                  '⏰ QR expires in 60 seconds',
                parse_mode: 'HTML',
                reply_markup: keyboards.waQrMenu().reply_markup,
              });
            } catch (_) {}
          },
          async (number) => {
            try {
              const freshUser = await storage.getUser(userId);
              const freshSettings = await storage.getSettings();
              if (!freshUser) return;
              await ctx.telegram.sendMessage(userId,
                `✅ <b>WhatsApp Connected!</b>\n\nNumber: <code>${number}</code>`,
                {
                  parse_mode: 'HTML',
                  reply_markup: keyboards.mainMenu(freshUser, freshSettings).reply_markup,
                }
              );
            } catch (_) {}
          },
          async (reason) => {
            if (reason === 'logged_out') {
              try {
                const freshUser = await storage.getUser(userId);
                const freshSettings = await storage.getSettings();
                if (!freshUser) return;
                await ctx.telegram.sendMessage(userId,
                  '⚠️ WhatsApp session was logged out. Please reconnect.',
                  { reply_markup: keyboards.mainMenu(freshUser, freshSettings).reply_markup }
                );
              } catch (_) {}
            }
          }
        );
        return;
      }

      if (data === 'wa_disconnect') {
        await waManager.disconnectSession(userId);
        const freshUser = await storage.getUser(userId);
        await ctx.editMessageText(
          '✅ *WhatsApp Disconnected.*',
          {
            parse_mode: 'Markdown',
            reply_markup: keyboards.mainMenu(freshUser, settings).reply_markup,
          }
        );
        return;
      }

      if (data === 'wa_regen_qr') {
        await waManager.regenQR(userId);
        await ctx.answerCbQuery('🔄 Regenerating QR...');
        return;
      }

      // ── Status / Account ───────────────────────────────────────────
      if (data === 'status_view') {
        const isMonitoring = await gramjs.isClientActive(userId);
        await ctx.editMessageText(
          `📊 *Your Status*\n\n` +
          `🔐 Logged in: ${user.session ? '✅ Yes' : '❌ No'}\n` +
          `📡 Monitoring: ${isMonitoring ? '🟢 Active' : '🔴 Stopped'}\n` +
          `📱 WhatsApp: ${user.whatsapp?.connected ? `✅ ${user.whatsapp.number}` : '❌ Not connected'}\n` +
          `🔔 Alerts Today: ${user.alertCount?.today || 0}\n` +
          `🔔 Alerts Total: ${user.alertCount?.total || 0}`,
          {
            parse_mode: 'Markdown',
            reply_markup: keyboards.mainMenuA(user, settings).reply_markup,
          }
        );
        return;
      }

      if (data === 'account_info') {
        await ctx.editMessageText(
          `👤 *Account Info*\n\n` +
          `🆔 ID: \`${userId}\`\n` +
          `👤 Name: ${user.telegram?.firstName || ''} ${user.telegram?.lastName || ''}\n` +
          `📛 Username: @${user.telegram?.username || 'N/A'}\n` +
          `📞 Phone: ${user.telegram?.phone || 'N/A'}\n` +
          `🤖 Mode: ${user.mode === 'monitor' ? '🕵️ Monitor' : user.mode === 'forwarder' ? '📲 Forwarder' : 'Not set'}\n` +
          `📅 Joined: ${user.status?.joinedAt?.split('T')[0] || 'N/A'}`,
          {
            parse_mode: 'Markdown',
            reply_markup: keyboards.mainMenu(user, settings).reply_markup,
          }
        );
        return;
      }

      // ── Help / Support ─────────────────────────────────────────────
      if (data === 'help_center') {
        await helpHandler.showHelpMenu(ctx);
        return;
      }
      if (data.startsWith('help_')) {
        const topic = data.replace('help_', '');
        await helpHandler.showHelp(ctx, topic);
        return;
      }

      if (data === 'support_contact') {
        await ctx.editMessageText(
          '💬 *Support Center*\n\nHow can we help you?',
          { parse_mode: 'Markdown', reply_markup: keyboards.supportMenu().reply_markup }
        );
        return;
      }
      if (data === 'support_open_ticket') {
        await verification.openTicket(ctx);
        return;
      }
      if (data === 'support_my_tickets') {
        const tickets = user.support?.tickets || [];
        if (tickets.length === 0) {
          await ctx.reply('📂 You have no support tickets.');
          return;
        }
        const list = tickets.slice(-5).map(t =>
          `🎫 \`${t.id}\` — ${t.status} — ${t.createdAt?.split('T')[0]}`
        ).join('\n');
        await ctx.reply(`📂 *Your Recent Tickets:*\n\n${list}`, { parse_mode: 'Markdown' });
        return;
      }

      // ── Bio / Force Join ───────────────────────────────────────────
      if (data === 'verify_bio_check') {
        const verified = await verification.checkBioVerification(userId);
        if (verified) {
          const freshUser = await storage.getUser(userId);
          await ctx.editMessageText(
            '✅ *Verified!* Your bio is set correctly.',
            { parse_mode: 'Markdown', reply_markup: keyboards.mainMenu(freshUser, settings).reply_markup }
          );
        } else {
          await ctx.answerCbQuery('❌ Bio text not found. Update your bio first.', { show_alert: true });
        }
        return;
      }

      if (data === 'verify_join') {
        const joined = await verification.checkForceJoin(bot, userId);
        if (joined) {
          const freshUser = await storage.getUser(userId);
          await ctx.editMessageText(
            '✅ *Verified!* You\'ve joined all required channels.',
            { parse_mode: 'Markdown', reply_markup: keyboards.mainMenu(freshUser, settings).reply_markup }
          );
        } else {
          await ctx.answerCbQuery('❌ You haven\'t joined all channels yet!', { show_alert: true });
        }
        return;
      }

      // ── Admin ──────────────────────────────────────────────────────
      if (adminHandler.isAdmin(userId)) {
        await handleAdminCallback(ctx, data, userId, bot);
        return;
      }

    } catch (err) {
      logger.error(`Callback error [${data}] for ${userId}: ${err.message}`);
      await ctx.answerCbQuery('❌ An error occurred', { show_alert: true });
    }
  });

  bot.catch((err, ctx) => {
    logger.error(`Bot error: ${err.message}`);
    ctx.reply('❌ An error occurred. Please try again.').catch(() => {});
  });

  return bot;
}

// ─── Mode B: Forward message to admin WA ──────────────────────────────────
async function handleForwarderMessage(ctx, user, textContent) {
  const userId   = ctx.from.id;
  const sender   = ctx.from;
  const time     = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

  const msg =
    `📩 *New Message on Your Bot*\n\n` +
    `👤 From: ${sender.first_name || ''} ${sender.last_name || ''}`.trim() + `\n` +
    (sender.username ? `📛 @${sender.username}\n` : '') +
    `🆔 ID: ${userId}\n` +
    `💬 Message: ${textContent}\n` +
    `🕐 Time: ${time}`;

  try {
    await sendForwardToAdminWA(msg, userId, user);

    // Increment counter
    await storage.updateUser(userId, u => {
      const today = new Date().toDateString();
      const f = u.forwarder || {};
      const lastReset = f.lastReset || today;
      return {
        ...u,
        forwarder: {
          ...f,
          totalForwarded: (f.totalForwarded || 0) + 1,
          todayForwarded: lastReset !== today ? 1 : (f.todayForwarded || 0) + 1,
          lastReset: today,
        },
      };
    });

    // Optional: auto-reply to sender
    const settings = await storage.getSettings();
    if (settings.forwarder?.autoReply) {
      await ctx.reply(settings.forwarder.autoReplyText || '✅ Message received! We\'ll get back to you soon.');
    }
  } catch (err) {
    logger.error(`Forwarder failed for ${userId}: ${err.message}`);
  }
}

async function sendForwardToAdminWA(message, userId, user) {
  const waManager = require('../whatsapp/manager');
  const adminWaNumber = process.env.ADMIN_WA_NUMBER;
  if (!adminWaNumber) {
    logger.warn('ADMIN_WA_NUMBER not set — cannot forward');
    return;
  }
  const jid = `${adminWaNumber.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
  await waManager.sendMessageAsAdmin(jid, message);
}

// ─── Admin Callbacks ───────────────────────────────────────────────────────
async function handleAdminCallback(ctx, data, userId, bot) {
  const adminCbs = {
    admin_panel:        () => adminHandler.showAdminPanel(ctx),
    admin_total_users:  () => adminHandler.showTotalUsers(ctx),
    admin_stats:        () => adminHandler.showSystemStats(ctx),
    admin_users:        () => adminHandler.showUserManagement(ctx),
    admin_broadcast:    () => adminHandler.startBroadcast(ctx),
    broadcast_confirm_all: () => adminHandler.executeBroadcast(ctx),
    admin_settings:     () => adminHandler.showSystemSettings(ctx),
    admin_logs:         () => adminHandler.showLogs(ctx),
    admin_forcejoin:    () => adminHandler.showForceJoinSettings(ctx),
    admin_bioverify:    () => adminHandler.showBioVerifySettings(ctx),
  };

  if (adminCbs[data]) { await adminCbs[data](); return; }

  const featureToggles = {
    admin_toggle_forcejoin:   'forceJoin',
    admin_toggle_bioverify:   'bioVerification',
    admin_toggle_admin_wa:    'adminWhatsappMode',
    admin_toggle_personal_wa: 'personalWhatsappMode',
    admin_toggle_maintenance: 'maintenanceMode',
  };
  if (featureToggles[data]) { await adminHandler.toggleFeature(ctx, featureToggles[data]); return; }

  const textChanges = {
    admin_change_support: ['support', 'Support Username'],
    admin_change_welcome: ['welcome', 'Welcome Message'],
    admin_change_biotext: ['biotext', 'Bio Required Text'],
    admin_change_footer:  ['footer', 'Footer Text'],
  };
  if (textChanges[data]) {
    const [field, label] = textChanges[data];
    await adminHandler.promptChangeText(ctx, field, label);
    ctx.session = { ...ctx.session, adminTextChange: field };
    return;
  }

  const match = data.match(/^admin_(ban|unban|delete|forcelogout|forceverify|premium)_(\d+)$/);
  if (match) {
    const [, action, targetId] = match;
    const actions = {
      ban:         adminHandler.banUser,
      unban:       adminHandler.unbanUser,
      delete:      adminHandler.deleteUser,
      forcelogout: adminHandler.forceLogoutUser,
      forceverify: adminHandler.forceVerifyUser,
      premium:     adminHandler.setPremium,
    };
    if (actions[action]) await actions[action](ctx, parseInt(targetId));
    return;
  }
}

module.exports = { createBot };
