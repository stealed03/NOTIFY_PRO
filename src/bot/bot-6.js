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
  const hasToken    = !!user?.forwarder?.botToken;
  const hasWaNumber = !!user?.forwarder?.waNumber;
  const forwarding  = user?.forwarder?.active;
  const tokenPreview = hasToken
    ? user.forwarder.botToken.slice(0, 10) + '...'
    : 'Not set';

  let status = '';
  if (!hasToken) {
    status = '⚠️ Step 1: Set your Bot Token below.';
  } else if (!hasWaNumber) {
    status = '⚠️ Step 2: Set your WhatsApp number below.';
  } else {
    status =
      `🤖 Bot Token: <code>${tokenPreview}</code>\n` +
      `📱 WA Number: <code>${user.forwarder.waNumber}</code>\n` +
      `📡 Forwarding: ${forwarding ? '🟢 Active' : '🔴 Stopped'}`;
  }

  return (
    `📲 <b>WA Message Forwarder</b>\n\n` +
    `📦 <b>How it works:</b>\n` +
    `1. Add your Bot Token (create a new bot via @BotFather)\n` +
    `2. Add your WhatsApp number (alerts will come here)\n` +
    `3. Anyone who messages your bot → Admin sends it to your WhatsApp\n\n` +
    `✅ <b>Status:</b>\n` +
    status
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
    const userId = ctx.from.id;

    // Already verified admin — go straight to panel
    if (adminHandler.isAdmin(userId)) {
      await adminHandler.showAdminPanel(ctx);
      return;
    }

    // Not in ADMIN_IDS — offer login code flow
    // Admin sets ADMIN_SECRET in env; user types /admin <secret>
    const parts  = ctx.message.text.split(' ');
    const secret = parts[1]?.trim();
    const envSecret = process.env.ADMIN_SECRET;

    if (!envSecret) {
      await ctx.reply('🚫 Access denied. Set ADMIN_SECRET env var and add your ID to ADMIN_IDS.');
      return;
    }

    if (secret && secret === envSecret) {
      // Add this user to runtime admin list
      adminHandler.addRuntimeAdmin(userId);
      await ctx.reply(
        '✅ *Admin access granted!*\n\n' +
        'Your ID: `' + userId + '`\n\n' +
        '💡 Add this ID to ADMIN_IDS env var to make it permanent.',
        { parse_mode: 'Markdown' }
      );
      await adminHandler.showAdminPanel(ctx);
    } else {
      await ctx.reply(
        '🔐 *Admin Login*\n\n' +
        'Send: `/admin <secret_code>`\n\n' +
        '_Example:_ `/admin mypassword123`',
        { parse_mode: 'Markdown' }
      );
    }
  });

  // ── Text Handler ───────────────────────────────────────────────────────
  bot.on('text', async (ctx, next) => {
    const userId = ctx.from.id;
    const text   = ctx.message.text;
    if (text.startsWith('/')) return next();

    const user = await storage.getUser(userId);
    if (!user) return next();

    // Mode B: Collect token / WA number steps
    if (user.mode === 'forwarder') {
      const step = user.status?.modeBStep;
      if (step === 'awaiting_token') {
        await handleSetBotToken(ctx, userId, text);
        return;
      }
      if (step === 'awaiting_wa_number') {
        await handleSetWaNumber(ctx, userId, text);
        return;
      }
      if (step === 'awaiting_wa_pair_number') {
        await handleWaPairNumber(ctx, userId, text);
        return;
      }
      // Forward incoming messages if active
      if (user.forwarder?.active) {
        await handleForwarderMessage(ctx, user, text);
        return;
      }
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
      // ── Mode B: Set Bot Token ────────────────────────────────────────
      if (data === 'forwarder_set_token') {
        await storage.updateUser(userId, u => ({
          ...u, status: { ...u.status, modeBStep: 'awaiting_token' },
        }));
        await ctx.editMessageText(
          '🤖 <b>Enter Your Bot Token</b>\n\n' +
          'Create a new bot via @BotFather and paste the token here.\n\n' +
          'Example: <code>123456789:AABBccDDeeFFggHH...</code>\n\n' +
          '⚠️ This must be a <b>different bot</b> from this one.',
          { parse_mode: 'HTML', reply_markup: keyboards.cancelButton('main_menu').reply_markup }
        );
        return;
      }

      // ── Mode B: Set WhatsApp Number ──────────────────────────────────
      if (data === 'forwarder_set_wa') {
        await storage.updateUser(userId, u => ({
          ...u, status: { ...u.status, modeBStep: 'awaiting_wa_number' },
        }));
        await ctx.editMessageText(
          '📱 <b>Enter Your WhatsApp Number</b>\n\n' +
          'Messages from your bot will be forwarded to this number.\n\n' +
          'Format: <code>+919876543210</code> (with country code)\n\n' +
          '⚠️ Make sure this number is active on WhatsApp.',
          { parse_mode: 'HTML', reply_markup: keyboards.cancelButton('main_menu').reply_markup }
        );
        return;
      }

      // ── Mode B: Start Forwarding ─────────────────────────────────────
      if (data === 'forwarder_start') {
        if (!user.forwarder?.botToken) {
          await ctx.answerCbQuery('❌ Set your Bot Token first!', { show_alert: true });
          return;
        }
        if (!user.forwarder?.waNumber) {
          await ctx.answerCbQuery('❌ Set your WhatsApp number first!', { show_alert: true });
          return;
        }
        // Check admin WA is connected
        const adminWaReady = waManager.isAdminConnected();
        if (!adminWaReady) {
          await ctx.answerCbQuery('❌ Admin WhatsApp not connected yet. Contact support.', { show_alert: true });
          return;
        }
        await storage.updateUser(userId, u => ({
          ...u,
          forwarder: { ...(u.forwarder || {}), active: true, startedAt: new Date().toISOString() },
        }));
        // Start listening on user's bot token
        await startUserBotListener(userId, user.forwarder.botToken);
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
        stopUserBotListener(userId);
        const freshUser = await storage.getUser(userId);
        await ctx.editMessageText(buildModeBWelcome(freshUser), {
          parse_mode: 'HTML',
          reply_markup: keyboards.mainMenuB(freshUser, settings).reply_markup,
        });
        await ctx.answerCbQuery('🔴 Forwarding stopped.');
        return;
      }

      if (data === 'forwarder_test') {
        if (!user.forwarder?.waNumber) {
          await ctx.answerCbQuery('❌ Set your WhatsApp number first!', { show_alert: true });
          return;
        }
        const waManager = require('../whatsapp/manager');
        await waManager.sendToUserWA(
          user.forwarder.waNumber,
          `🧪 *Test Message*\n\nYour TeleForward bot forwarding is working!\nTime: ${new Date().toLocaleString()}`
        );
        await ctx.answerCbQuery('✅ Test sent to your WhatsApp!', { show_alert: true });
        return;
      }

      if (data === 'forwarder_stats') {
        const stats = user.forwarder || {};
        await ctx.editMessageText(
          `📊 <b>Forwarder Stats</b>\n\n` +
          `📨 Total forwarded: ${stats.totalForwarded || 0}\n` +
          `📅 Today: ${stats.todayForwarded || 0}\n` +
          `📡 Status: ${stats.active ? '🟢 Active' : '🔴 Stopped'}\n` +
          `🤖 Bot Token: ${stats.botToken ? stats.botToken.slice(0,10)+'...' : 'Not set'}\n` +
          `📱 WA Number: ${stats.waNumber || 'Not set'}`,
          {
            parse_mode: 'HTML',
            reply_markup: keyboards.mainMenuB(user, settings).reply_markup,
          }
        );
        return;
      }

      if (data === 'forwarder_howto') {
        await ctx.editMessageText(
          `📲 <b>How WA Forwarder Works</b>\n\n` +
          `<b>Step 1:</b> Create a new bot via @BotFather → copy the token → paste it here\n\n` +
          `<b>Step 2:</b> Enter your WhatsApp number (this is where messages will arrive)\n\n` +
          `<b>Step 3:</b> Tap Start Forwarding\n\n` +
          `<b>Result:</b> Anyone who messages your bot → You get it on WhatsApp instantly\n\n` +
          `✅ Admin's WhatsApp sends the message to you\n` +
          `✅ Sender name, username & ID included\n` +
          `✅ Works 24/7`,
          {
            parse_mode: 'HTML',
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
          '🚪 <b>Are you sure you want to logout?</b>\n\nThis will stop all monitoring.',
          {
            parse_mode: 'HTML',
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
      // ── Cancel pending WA connection ─────────────────────────────────
      if (data === 'wa_cancel_qr') {
        await waManager.cancelPendingConnection(userId);
        const freshUser    = await storage.getUser(userId);
        const freshSettings = await storage.getSettings();
        await ctx.editMessageText(
          '❌ <b>WhatsApp connection cancelled.</b>\n\nTap the button below to try again.',
          {
            parse_mode: 'HTML',
            reply_markup: keyboards.mainMenu(freshUser || user, freshSettings).reply_markup,
          }
        );
        return;
      }

      // ── WA Connect — show method choice ──────────────────────────────
      if (data === 'wa_connect') {
        await ctx.editMessageText(
          '📱 <b>Connect WhatsApp</b>\n\n' +
          'Choose how you want to link:\n\n' +
          '📷 <b>QR Code</b> — Open WhatsApp → Linked Devices → Scan QR\n\n' +
          '📱 <b>Phone Number Code</b> — No camera needed. Enter 8-digit code in WhatsApp',
          {
            parse_mode: 'HTML',
            reply_markup: keyboards.waConnectMethodMenu().reply_markup,
          }
        );
        return;
      }

      // ── WA Connect via QR ─────────────────────────────────────────────
      if (data === 'wa_connect_qr') {
        await ctx.editMessageText(
          '📷 <b>Generating QR Code...</b>\n\nPlease wait a moment.',
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
        const freshSettings = await storage.getSettings();
        await ctx.editMessageText(
          '✅ <b>WhatsApp Disconnected.</b>',
          {
            parse_mode: 'HTML',
            reply_markup: keyboards.mainMenu(freshUser || user, freshSettings).reply_markup,
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

// ─── Mode B: Set Bot Token ────────────────────────────────────────────────
async function handleSetBotToken(ctx, userId, text) {
  // Basic token format check: digits:alphanumeric (min length)
  const tokenRegex = /^\d{8,12}:[A-Za-z0-9_-]{35,}$/;
  if (!tokenRegex.test(text.trim())) {
    await ctx.reply(
      '❌ <b>Invalid Bot Token format.</b>\n\nIt should look like:\n<code>123456789:AABBccDDeeFFggHHiiJJkkLL...</code>\n\nGet it from @BotFather.',
      { parse_mode: 'HTML', reply_markup: keyboards.cancelButton('main_menu').reply_markup }
    );
    return;
  }

  await storage.updateUser(userId, u => ({
    ...u,
    forwarder: { ...(u.forwarder || {}), botToken: text.trim() },
    status: { ...u.status, modeBStep: null },
  }));

  const freshUser = await storage.getUser(userId);
  const settings  = await storage.getSettings();
  await ctx.reply(
    '✅ <b>Bot Token saved!</b>\n\nNow set your WhatsApp number to receive messages.',
    {
      parse_mode: 'HTML',
      reply_markup: keyboards.mainMenuB(freshUser, settings).reply_markup,
    }
  );
}

// ─── WA Pairing Code — get number then request code ──────────────────────
async function handleWaPairNumber(ctx, userId, text) {
  const cleaned = text.trim().replace(/\s/g, '');
  const waRegex = /^\+?\d{10,15}$/;
  if (!waRegex.test(cleaned)) {
    await ctx.reply(
      '❌ <b>Invalid number.</b>\n\nFormat: <code>+919876543210</code>',
      { parse_mode: 'HTML', reply_markup: keyboards.cancelButton('main_menu').reply_markup }
    );
    return;
  }

  const phoneNumber = cleaned.startsWith('+') ? cleaned.slice(1) : cleaned;

  await storage.updateUser(userId, u => ({
    ...u, status: { ...u.status, modeBStep: null },
  }));

  const waitMsg = await ctx.reply('⏳ <b>Pairing code generate ho raha hai...</b>', { parse_mode: 'HTML' });

  try {
    await waManager.startPairingSession(
      userId,
      phoneNumber,
      async (code) => {
        await ctx.telegram.editMessageText(
          ctx.chat.id, waitMsg.message_id, null,
          `🔑 <b>Tumhara Pairing Code:</b>\n\n` +
          `<code>${code}</code>\n\n` +
          `<b>Yeh code WhatsApp mein enter karo:</b>\n` +
          `1. WhatsApp kholo\n` +
          `2. Settings → Linked Devices → Link a Device\n` +
          `3. "Link with phone number" tap karo\n` +
          `4. Upar diya code enter karo\n\n` +
          `⏰ Code 5 minute mein expire hoga`,
          {
            parse_mode: 'HTML',
            reply_markup: keyboards.waPairMenu().reply_markup,
          }
        );
      },
      async (number) => {
        const freshUser     = await storage.getUser(userId);
        const freshSettings = await storage.getSettings();
        await ctx.telegram.sendMessage(userId,
          `✅ <b>WhatsApp Connected!</b>\n\nNumber: <code>+${number}</code>`,
          {
            parse_mode: 'HTML',
            reply_markup: keyboards.mainMenu(freshUser || user, freshSettings).reply_markup,
          }
        );
      },
      async (reason) => {
        if (reason === 'logged_out') {
          const freshUser     = await storage.getUser(userId);
          const freshSettings = await storage.getSettings();
          await ctx.telegram.sendMessage(userId,
            '⚠️ WhatsApp logout ho gaya. Dobara connect karo.',
            { reply_markup: keyboards.mainMenu(freshUser, freshSettings).reply_markup }
          ).catch(() => {});
        }
      }
    );
  } catch (err) {
    await ctx.telegram.editMessageText(
      ctx.chat.id, waitMsg.message_id, null,
      `❌ <b>Pairing failed:</b> ${err.message}\n\nDobara try karo.`,
      { parse_mode: 'HTML', reply_markup: keyboards.cancelButton('main_menu').reply_markup }
    ).catch(() => {});
  }
}

// ─── Mode B: Set WhatsApp Number ──────────────────────────────────────────
async function handleSetWaNumber(ctx, userId, text) {
  // Accept +91... or 91... or just digits
  const cleaned = text.trim().replace(/\s/g, '');
  const waRegex = /^\+?\d{10,15}$/;
  if (!waRegex.test(cleaned)) {
    await ctx.reply(
      '❌ <b>Invalid number.</b>\n\nFormat: <code>+919876543210</code>',
      { parse_mode: 'HTML', reply_markup: keyboards.cancelButton('main_menu').reply_markup }
    );
    return;
  }

  const waNumber = cleaned.startsWith('+') ? cleaned.slice(1) : cleaned;

  await storage.updateUser(userId, u => ({
    ...u,
    forwarder: { ...(u.forwarder || {}), waNumber },
    status: { ...u.status, modeBStep: null },
  }));

  const freshUser = await storage.getUser(userId);
  const settings  = await storage.getSettings();

  await ctx.reply(
    `✅ <b>WhatsApp number saved!</b>\n\n` +
    `📱 Number: <code>+${waNumber}</code>\n\n` +
    `⚠️ <b>Important — Do this first:</b>\n` +
    `Before starting forwarding, please send <b>any message</b> (e.g. "Hi") from your WhatsApp number <code>+${waNumber}</code> to this WhatsApp number:\n\n` +
    `<code>${process.env.ADMIN_WA_NUMBER || 'Admin WA number (set by admin)'}</code>\n\n` +
    `This is required so WhatsApp doesn't flag the bot as spam. ✅\n\n` +
    `Once done, tap <b>Start Forwarding</b>! 🚀`,
    {
      parse_mode: 'HTML',
      reply_markup: keyboards.mainMenuB(freshUser, settings).reply_markup,
    }
  );
}

// ─── Mode B: Greeting for first-time senders ─────────────────────────────
async function sendGreetingIfNew(ctx, userId, user) {
  const settings = await storage.getSettings();
  const botInfo  = await ctx.telegram.getMe().catch(() => ({ username: '' }));
  const botUsername = settings.bot?.botUsername || botInfo.username || 'this bot';
  const adminUsername = settings.bot?.adminUsername || '@admin';

  // Check if this sender has messaged before
  const senderKey = `greeted_${ctx.from.id}`;
  const ownerUser = user; // user here = the bot owner (mode B user)

  if (!ownerUser.forwarder?.greetedSenders?.includes(ctx.from.id)) {
    const greeting = (settings.bot?.greetingMessage || 
      "👋 *Welcome!*\n\nThis bot is managed by *{adminUsername}*.\n📩 Send your message and the owner will reply soon!\n\n⚡ @{botUsername}")
      .replace('{adminUsername}', adminUsername)
      .replace('{botUsername}', botUsername);

    await ctx.reply(greeting, { parse_mode: 'Markdown' });

    // Mark this sender as greeted
    await storage.updateUser(ownerUser.id, u => ({
      ...u,
      forwarder: {
        ...u.forwarder,
        greetedSenders: [...(u.forwarder?.greetedSenders || []), ctx.from.id].slice(-500),
      },
    }));
  }
}

// ─── Mode B: Forward incoming message to user's WA via Admin WA ───────────
async function handleForwarderMessage(ctx, user, textContent) {
  const sender  = ctx.from;
  const ownerId = user.id;
  const time    = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  const settings = await storage.getSettings();
  const botInfo  = await ctx.telegram.getMe().catch(() => ({ username: 'bot' }));
  const botUsername = settings.bot?.botUsername || botInfo.username || 'bot';
  const adminUsername = settings.bot?.adminUsername || '@admin';

  // Send greeting to new senders
  await sendGreetingIfNew(ctx, sender.id, user);

  const waNumber = user.forwarder?.waNumber;
  if (!waNumber) {
    logger.warn(`No WA number set for user ${ownerId}`);
    return;
  }

  // Format forwarded message
  const senderName = [sender.first_name, sender.last_name].filter(Boolean).join(' ') || 'Unknown';
  const msg =
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `📩 *New Message Received*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `👤 *From:* ${senderName}\n` +
    (sender.username ? `📛 *Username:* @${sender.username}\n` : '') +
    `🆔 *ID:* ${sender.id}\n` +
    `🕐 *Time:* ${time}\n\n` +
    `💬 *Message:*\n${textContent}\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🤖 Via @${botUsername}`;

  try {
    await waManager.sendToUserWA(waNumber, msg);

    // Confirmation to sender
    const confirmText = (settings.bot?.confirmationMessage ||
      "✅ *Message Forwarded!*\n\nYour message has been sent to the owner.\n📞 He will reply as soon as possible.\n\n🤖 Bot: @{botUsername}\n👤 Owner: {adminUsername}")
      .replace('{botUsername}', botUsername)
      .replace('{adminUsername}', adminUsername);

    await ctx.reply(confirmText, { parse_mode: 'Markdown' });

    // Increment counter
    await storage.updateUser(ownerId, u => {
      const today = new Date().toDateString();
      const f = u.forwarder || {};
      return {
        ...u,
        forwarder: {
          ...f,
          totalForwarded: (f.totalForwarded || 0) + 1,
          todayForwarded: f.lastReset !== today ? 1 : (f.todayForwarded || 0) + 1,
          lastReset: today,
        },
      };
    });

  } catch (err) {
    logger.error(`Forwarder failed for ${ownerId}: ${err.message}`);
    await ctx.reply('⚠️ Sorry, message could not be delivered right now. Please try again.').catch(() => {});
  }
}

// ─── Mode B: User Bot Listeners (each user's separate bot token) ──────────
// Map of userId → child Telegraf instance
const userBots = new Map();

async function startUserBotListener(userId, botToken) {
  if (userBots.has(userId)) return; // Already running

  try {
    const { Telegraf: TelegrafChild } = require('telegraf');
    const childBot = new TelegrafChild(botToken);

    childBot.on('message', async (ctx) => {
      const user = await storage.getUser(userId);
      if (!user?.forwarder?.active || !user?.forwarder?.waNumber) return;
      const text = ctx.message?.text || ctx.message?.caption || '[Media]';
      await handleForwarderMessage(ctx, user, text);
    });

    // Launch without blocking
    childBot.launch().catch(err => {
      logger.error(`Child bot launch failed for ${userId}: ${err.message}`);
      userBots.delete(userId);
    });

    userBots.set(userId, childBot);
    logger.info(`User bot listener started for ${userId}`);
  } catch (err) {
    logger.error(`startUserBotListener failed for ${userId}: ${err.message}`);
  }
}

function stopUserBotListener(userId) {
  const childBot = userBots.get(userId);
  if (childBot) {
    try { childBot.stop(); } catch (_) {}
    userBots.delete(userId);
    logger.info(`User bot listener stopped for ${userId}`);
  }
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
    admin_wa_connect:   () => handleAdminWaConnect(ctx),
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
    admin_change_support:   ['support',   'Support Username'],
    admin_change_welcome:   ['welcome',   'Welcome Message'],
    admin_change_biotext:   ['biotext',   'Bio Required Text'],
    admin_change_footer:    ['footer',    'Footer Text'],
    admin_change_botuser:   ['botuser',   'Bot Username (shown in messages)'],
    admin_change_adminuser: ['adminuser', 'Admin Username (shown in greetings)'],
    admin_change_greeting:  ['greeting',  'Greeting Message for new senders'],
    admin_change_confirm:   ['confirm',   'Confirmation Message after forward'],
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

// ─── Admin WA Connect ─────────────────────────────────────────────────────
async function handleAdminWaConnect(ctx) {
  const alreadyConnected = waManager.isAdminConnected();
  if (alreadyConnected) {
    await ctx.editMessageText(
      '✅ <b>Admin WhatsApp already connected!</b>\n\nAll user forwarders are using this session.',
      { parse_mode: 'HTML', reply_markup: keyboards.adminMenu().reply_markup }
    );
    return;
  }

  await ctx.editMessageText(
    '📱 <b>Connecting Admin WhatsApp...</b>\n\nGenerating QR code...',
    { parse_mode: 'HTML' }
  );

  const adminId = ctx.from.id;

  await waManager.startAdminSession(
    async (qrBuffer) => {
      try {
        await ctx.telegram.sendPhoto(adminId, { source: qrBuffer }, {
          caption:
            '📱 <b>Scan this QR with Admin WhatsApp</b>\n\n' +
            '1. Open WhatsApp\n' +
            '2. Settings → Linked Devices → Link a Device\n' +
            '3. Scan this QR\n\n' +
            '⚠️ This WhatsApp will send messages to all users.',
          parse_mode: 'HTML',
        });
      } catch (_) {}
    },
    async (number) => {
      try {
        await ctx.telegram.sendMessage(adminId,
          `✅ <b>Admin WhatsApp Connected!</b>\n\nNumber: <code>${number}</code>\n\nAll user forwarders are now active.`,
          { parse_mode: 'HTML', reply_markup: keyboards.adminMenu().reply_markup }
        );
      } catch (_) {}
    }
  );
}

module.exports = { createBot, restoreUserBotListeners };

// Restore all user bot listeners on startup
async function restoreUserBotListeners() {
  const users = await storage.getAllUsers();
  for (const user of users) {
    if (user.mode === 'forwarder' && user.forwarder?.active && user.forwarder?.botToken) {
      await startUserBotListener(user.id, user.forwarder.botToken);
      await new Promise(r => setTimeout(r, 300));
    }
  }
}
