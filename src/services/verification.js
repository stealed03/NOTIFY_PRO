/**
 * services/verification.js - Bio verification + force join checker
 */

const logger = require('../utils/logger');
const storage = require('../utils/storage');
const gramjs = require('../gramjs/client');
const keyboards = require('../bot/keyboards');

// ─── Bio Verification ──────────────────────────────────────────────────────

/**
 * Check if user's Telegram bio contains the required text
 */
async function checkBioVerification(userId) {
  const settings = await storage.getSettings();
  if (!settings.features?.bioVerification) return true; // Feature disabled → pass

  const user = await storage.getUser(userId);
  if (!user) return false;

  // Premium bypass
  if (user.premium?.active && settings.bioVerification?.premiumBypass) return true;

  // Admin whitelist bypass
  const whitelisted = settings.bioVerification?.whitelistedUsers || [];
  if (whitelisted.includes(userId)) return true;

  // Already bypassed by admin force verify
  if (user.verification?.bypassed) return true;

  // Need active session to check bio
  if (!user.session) return false;

  try {
    const requiredText = settings.bioVerification?.requiredText || '';
    const client = await getClientForUser(userId, user);
    if (!client) return false;

    const me = await client.getMe();
    const bio = me.about || '';

    const verified = bio.toLowerCase().includes(requiredText.toLowerCase());

    await storage.updateUser(userId, u => ({
      ...u,
      verification: {
        ...u.verification,
        status: verified,
        lastChecked: new Date().toISOString(),
      },
    }));

    return verified;
  } catch (err) {
    logger.error(`Bio check failed for ${userId}: ${err.message}`);
    return false;
  }
}

/**
 * Show verification required message
 */
async function promptVerification(ctx) {
  const settings = await storage.getSettings();
  const requiredText = settings.bioVerification?.requiredText || '@YourBot';

  await ctx.reply(
    `✅ *Bio Verification Required*\n\n` +
    `To use this bot, please add the following text to your Telegram bio:\n\n` +
    `\`${requiredText}\`\n\n` +
    `📋 *How to update your bio:*\n` +
    `1. Open Telegram Settings\n` +
    `2. Tap Edit Profile\n` +
    `3. Add the text above to your Bio field\n` +
    `4. Save and tap "Check Verification" below`,
    {
      parse_mode: 'Markdown',
      reply_markup: keyboards.verificationMenu().reply_markup,
    }
  );
}

/**
 * Periodic re-check of all users' bio verification
 */
async function recheckAllBios() {
  const settings = await storage.getSettings();
  if (!settings.features?.bioVerification) return;

  const users = await storage.getAllUsers();
  let checked = 0, revoked = 0;

  for (const user of users) {
    if (!user.session || user.verification?.bypassed) continue;
    try {
      const verified = await checkBioVerification(user.id);
      if (!verified && user.verification?.status) {
        // Was verified before, now not → alert and disable
        revoked++;
        await storage.updateUser(user.id, u => ({
          ...u,
          settings: { ...u.settings, alertsEnabled: false },
          verification: { ...u.verification, status: false },
        }));
        logger.info(`Bio verification revoked for user ${user.id}`);
      }
      checked++;
    } catch (_) {}
    await new Promise(r => setTimeout(r, 500)); // Avoid spam
  }

  logger.info(`Bio recheck: ${checked} checked, ${revoked} revoked`);
}

// ─── Force Join Verification ───────────────────────────────────────────────

/**
 * Check if user has joined all required channels
 */
async function checkForceJoin(bot, userId) {
  const settings = await storage.getSettings();
  if (!settings.features?.forceJoin) return true;

  const channels = settings.forceJoin?.channels || [];
  if (channels.length === 0) return true;

  const notJoined = [];

  for (const channel of channels) {
    try {
      const member = await bot.telegram.getChatMember(
        channel.id || channel.username,
        userId
      );
      const joined = ['member', 'administrator', 'creator'].includes(member.status);
      if (!joined) notJoined.push(channel);
    } catch (err) {
      logger.debug(`Force join check error for ${userId} in ${channel.id}: ${err.message}`);
      notJoined.push(channel); // Assume not joined on error
    }
  }

  return notJoined.length === 0;
}

/**
 * Show force join prompt with channel buttons
 */
async function promptForceJoin(ctx) {
  const settings = await storage.getSettings();
  const channels = settings.forceJoin?.channels || [];

  await ctx.reply(
    `🔗 *Join Required Channels*\n\n` +
    `You must join the following channels to use this bot:`,
    {
      parse_mode: 'Markdown',
      reply_markup: keyboards.forceJoinMenu(channels).reply_markup,
    }
  );
}

// ─── Support / Ticket System ───────────────────────────────────────────────

let ticketCounter = Date.now();

async function openTicket(ctx) {
  const userId = ctx.from.id;
  const user = await storage.getUser(userId);

  if (user.support?.activeTicket) {
    await ctx.reply(
      `📝 You already have an open ticket: *#${user.support.activeTicket}*\n\nPlease wait for a response before opening a new one.`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  await storage.updateUser(userId, u => ({
    ...u,
    status: { ...u.status, supportStep: 'awaiting_message' },
  }));

  await ctx.reply(
    '📝 *Open Support Ticket*\n\n' +
    'Please describe your issue in detail.\n\n' +
    '_Type your message and send it:_',
    {
      parse_mode: 'Markdown',
      reply_markup: keyboards.cancelButton('main_menu').reply_markup,
    }
  );
}

async function submitTicket(ctx, message) {
  const userId = ctx.from.id;
  const ticketId = `TKT-${++ticketCounter}`;
  const settings = await storage.getSettings();

  const ticket = {
    id: ticketId,
    userId,
    message,
    createdAt: new Date().toISOString(),
    status: 'open',
    replies: [],
  };

  await storage.updateUser(userId, u => ({
    ...u,
    support: {
      activeTicket: ticketId,
      tickets: [...(u.support?.tickets || []), ticket],
    },
    status: { ...u.status, supportStep: null },
  }));

  await ctx.reply(
    `✅ *Ticket Submitted!*\n\n` +
    `🎫 Ticket ID: \`${ticketId}\`\n` +
    `📋 Message: ${message.substring(0, 100)}...\n\n` +
    `We'll respond as soon as possible.\n` +
    `Contact: ${settings.bot?.supportUsername || '@support'}`,
    {
      parse_mode: 'Markdown',
      reply_markup: keyboards.mainMenu(await storage.getUser(userId), settings).reply_markup,
    }
  );

  // Notify admin
  const adminIds = (process.env.ADMIN_IDS || '').split(',').map(Number).filter(Boolean);
  for (const adminId of adminIds) {
    try {
      await ctx.telegram.sendMessage(
        adminId,
        `🎫 *New Support Ticket*\n\n` +
        `ID: \`${ticketId}\`\n` +
        `From: ${userId} (@${ctx.from.username || 'N/A'})\n` +
        `Message: ${message.substring(0, 500)}`,
        { parse_mode: 'Markdown' }
      );
    } catch (_) {}
  }

  logger.info(`Ticket ${ticketId} submitted by user ${userId}`);
}

// ─── Helper: Get Active GramJS Client for User ─────────────────────────────
async function getClientForUser(userId, user) {
  // Try to get existing active client
  const { getActiveUserIds } = require('../gramjs/client');
  const activeIds = getActiveUserIds();

  if (activeIds.includes(String(userId)) || activeIds.includes(userId)) {
    // Client is already running — import directly
    const clients = require('../gramjs/client');
    return null; // Direct client access not exposed; bio check handled differently
  }

  return null;
}

module.exports = {
  checkBioVerification,
  promptVerification,
  recheckAllBios,
  checkForceJoin,
  promptForceJoin,
  openTicket,
  submitTicket,
};
