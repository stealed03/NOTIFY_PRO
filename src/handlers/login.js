/**
 * handlers/login.js - Multi-step Telegram login flow handler
 * Steps: API ID → API HASH → Phone → OTP → (2FA) → Done
 */

const logger = require('../utils/logger');
const storage = require('../utils/storage');
const gramjs = require('../gramjs/client');
const keyboards = require('../bot/keyboards');

// ─── Login State Machine ───────────────────────────────────────────────────
// States: idle → awaiting_api_id → awaiting_api_hash → awaiting_phone
//         → awaiting_otp → awaiting_2fa → done

const LOGIN_STEPS = {
  IDLE: 'idle',
  API_ID: 'awaiting_api_id',
  API_HASH: 'awaiting_api_hash',
  PHONE: 'awaiting_phone',
  OTP: 'awaiting_otp',
  TWO_FA: 'awaiting_2fa',
  DONE: 'done',
};

// Timeout per step (ms)
const STEP_TIMEOUT = 5 * 60 * 1000; // 5 minutes
const stepTimers = new Map();

// ─── Start Login ───────────────────────────────────────────────────────────
async function startLogin(ctx) {
  const userId = ctx.from.id;
  const user = await storage.getUser(userId) || await storage.createUser(userId, ctx.from);

  if (user.session) {
    await ctx.reply('⚠️ You already have an active session. Please logout first.', {
      reply_markup: keyboards.confirmMenu('logout_confirm', 'main_menu', '🚪 Logout', '🔙 Cancel').reply_markup,
    });
    return;
  }

  // Set initial login state
  await storage.updateUser(userId, u => ({
    ...u,
    status: { ...u.status, loginState: LOGIN_STEPS.API_ID, loginData: {} },
  }));

  setStepTimeout(userId, ctx);

  await ctx.reply(
    '🔐 *Login to Your Telegram Account*\n\n' +
    'To monitor your account, I need your Telegram API credentials.\n\n' +
    '📌 *Step 1 of 4*\n' +
    'Please send your *API ID*\n\n' +
    '💡 Get your API credentials at: https://my.telegram.org/apps\n' +
    '_(Create an app if you haven\'t yet)_',
    {
      parse_mode: 'Markdown',
      reply_markup: keyboards.cancelButton('login_cancel').reply_markup,
    }
  );
}

// ─── Handle Incoming Text During Login ────────────────────────────────────
async function handleLoginStep(ctx) {
  const userId = ctx.from.id;
  const text = ctx.message?.text?.trim();
  if (!text) return false;

  const user = await storage.getUser(userId);
  if (!user) return false;

  const state = user.status?.loginState;
  if (!state || state === LOGIN_STEPS.IDLE || state === LOGIN_STEPS.DONE) return false;

  // Reset timeout
  setStepTimeout(userId, ctx);

  switch (state) {
    case LOGIN_STEPS.API_ID:
      return await handleApiId(ctx, userId, text);
    case LOGIN_STEPS.API_HASH:
      return await handleApiHash(ctx, userId, text);
    case LOGIN_STEPS.PHONE:
      return await handlePhone(ctx, userId, text);
    case LOGIN_STEPS.OTP:
      return await handleOTP(ctx, userId, text);
    case LOGIN_STEPS.TWO_FA:
      return await handleTwoFA(ctx, userId, text);
    default:
      return false;
  }
}

// ─── Step 1: API ID ────────────────────────────────────────────────────────
async function handleApiId(ctx, userId, text) {
  const apiId = parseInt(text);
  if (!apiId || isNaN(apiId) || apiId < 1000) {
    await ctx.reply(
      '❌ Invalid API ID. It should be a number (e.g. `12345678`)\n\nPlease try again:',
      { parse_mode: 'Markdown', reply_markup: keyboards.cancelButton('login_cancel').reply_markup }
    );
    return true;
  }

  await storage.updateUser(userId, u => ({
    ...u,
    status: {
      ...u.status,
      loginState: LOGIN_STEPS.API_HASH,
      loginData: { ...u.status.loginData, apiId },
    },
  }));

  await ctx.reply(
    '✅ API ID saved!\n\n' +
    '📌 *Step 2 of 4*\n' +
    'Please send your *API HASH*\n\n' +
    '_It looks like: `a1b2c3d4e5f6...` (32 characters)_',
    { parse_mode: 'Markdown', reply_markup: keyboards.cancelButton('login_cancel').reply_markup }
  );
  return true;
}

// ─── Step 2: API HASH ──────────────────────────────────────────────────────
async function handleApiHash(ctx, userId, text) {
  if (!text || text.length < 20) {
    await ctx.reply(
      '❌ Invalid API HASH. It should be a 32-character string.\n\nPlease try again:',
      { parse_mode: 'Markdown', reply_markup: keyboards.cancelButton('login_cancel').reply_markup }
    );
    return true;
  }

  await storage.updateUser(userId, u => ({
    ...u,
    status: {
      ...u.status,
      loginState: LOGIN_STEPS.PHONE,
      loginData: { ...u.status.loginData, apiHash: text },
    },
  }));

  await ctx.reply(
    '✅ API HASH saved!\n\n' +
    '📌 *Step 3 of 4*\n' +
    'Please send your *phone number* in international format\n\n' +
    '📞 Example: `+14155552671`',
    { parse_mode: 'Markdown', reply_markup: keyboards.cancelButton('login_cancel').reply_markup }
  );
  return true;
}

// ─── Step 3: Phone Number ─────────────────────────────────────────────────
async function handlePhone(ctx, userId, text) {
  const phone = text.startsWith('+') ? text : '+' + text;

  if (!/^\+\d{8,15}$/.test(phone)) {
    await ctx.reply(
      '❌ Invalid phone number format.\n\nPlease use international format: `+14155552671`',
      { parse_mode: 'Markdown', reply_markup: keyboards.cancelButton('login_cancel').reply_markup }
    );
    return true;
  }

  const user = await storage.getUser(userId);
  const { apiId, apiHash } = user.status.loginData;

  const waitMsg = await ctx.reply('⏳ Sending OTP to your Telegram...');

  try {
    const { phoneCodeHash } = await gramjs.createLoginSession(apiId, apiHash, phone, userId);

    await storage.updateUser(userId, u => ({
      ...u,
      status: {
        ...u.status,
        loginState: LOGIN_STEPS.OTP,
        loginData: { ...u.status.loginData, phone, phoneCodeHash },
      },
    }));

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      waitMsg.message_id,
      null,
      '✅ OTP sent!\n\n' +
      '📌 *Step 4 of 4*\n' +
      'Please enter the *OTP code* you received on Telegram.\n\n' +
      '💡 Send the code with spaces: `1 2 3 4 5` or without: `12345`\n\n' +
      '⏰ Code expires in 5 minutes.',
      { parse_mode: 'Markdown', reply_markup: keyboards.cancelButton('login_cancel').reply_markup }
    );
  } catch (err) {
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      waitMsg.message_id,
      null,
      `❌ Failed to send OTP: \`${err.message}\`\n\nPlease check your phone number and try again.`,
      { parse_mode: 'Markdown', reply_markup: keyboards.cancelButton('login_cancel').reply_markup }
    );
    await resetLogin(userId);
  }
  return true;
}

// ─── Step 4: OTP ──────────────────────────────────────────────────────────
async function handleOTP(ctx, userId, text) {
  // Strip spaces from OTP input
  const otp = text.replace(/\s/g, '');

  if (!/^\d{5,6}$/.test(otp)) {
    await ctx.reply(
      '❌ Invalid OTP. It should be a 5-6 digit number.\n\nPlease try again:',
      { reply_markup: keyboards.cancelButton('login_cancel').reply_markup }
    );
    return true;
  }

  const user = await storage.getUser(userId);
  const { phone, phoneCodeHash, apiId, apiHash } = user.status.loginData;

  const waitMsg = await ctx.reply('⏳ Verifying OTP...');

  try {
    const session = await gramjs.completeLogin(userId, phone, otp, phoneCodeHash);

    await storage.updateUser(userId, u => ({
      ...u,
      session,
      status: {
        ...u.status,
        loginState: LOGIN_STEPS.DONE,
        loginData: { apiId, apiHash }, // Keep credentials, clear sensitive data
      },
      telegram: { ...u.telegram, phone },
    }));

    clearStepTimeout(userId);

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      waitMsg.message_id,
      null,
      '🎉 *Login Successful!*\n\n' +
      'Your Telegram account is now connected.\n' +
      'Use *Start Alerts* to begin monitoring.\n\n' +
      '📱 You can also connect WhatsApp to receive alerts there.',
      { parse_mode: 'Markdown' }
    );

    // Show main menu
    const settings = await storage.getSettings();
    const freshUser = await storage.getUser(userId);
    await ctx.reply('🏠 *Main Menu*', {
      parse_mode: 'Markdown',
      reply_markup: keyboards.mainMenu(freshUser, settings).reply_markup,
    });

    logger.info(`User ${userId} logged in successfully`);
  } catch (err) {
    if (err.message === '2FA_REQUIRED') {
      // Handle 2FA
      await storage.updateUser(userId, u => ({
        ...u,
        status: { ...u.status, loginState: LOGIN_STEPS.TWO_FA },
      }));

      await ctx.telegram.editMessageText(
        ctx.chat.id,
        waitMsg.message_id,
        null,
        '🔒 *Two-Factor Authentication Required*\n\n' +
        'Your account has 2FA enabled.\n' +
        'Please send your *2FA password*:',
        { parse_mode: 'Markdown', reply_markup: keyboards.cancelButton('login_cancel').reply_markup }
      );
    } else {
      const errMsg = err.errorMessage || err.message;
      let hint = '';
      if (errMsg?.includes('PHONE_CODE_INVALID')) hint = '\n\n💡 Make sure you entered the correct code.';
      if (errMsg?.includes('PHONE_CODE_EXPIRED')) hint = '\n\n💡 Code expired. Please restart login.';

      await ctx.telegram.editMessageText(
        ctx.chat.id,
        waitMsg.message_id,
        null,
        `❌ Verification failed: \`${errMsg}\`${hint}\n\nPlease try again or restart login.`,
        { parse_mode: 'Markdown', reply_markup: keyboards.cancelButton('login_cancel').reply_markup }
      );
    }
  }
  return true;
}

// ─── Step 5: 2FA Password ─────────────────────────────────────────────────
async function handleTwoFA(ctx, userId, text) {
  const user = await storage.getUser(userId);
  const { phone, phoneCodeHash } = user.status.loginData;

  const waitMsg = await ctx.reply('⏳ Verifying 2FA password...');

  try {
    const session = await gramjs.completeLogin(userId, phone, null, phoneCodeHash, text);

    await storage.updateUser(userId, u => ({
      ...u,
      session,
      status: {
        ...u.status,
        loginState: LOGIN_STEPS.DONE,
        loginData: { apiId: u.status.loginData.apiId, apiHash: u.status.loginData.apiHash },
      },
      telegram: { ...u.telegram, phone },
    }));

    clearStepTimeout(userId);

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      waitMsg.message_id,
      null,
      '🎉 *Login Successful!*\n\n2FA verified. Your account is now connected!',
      { parse_mode: 'Markdown' }
    );

    const settings = await storage.getSettings();
    const freshUser = await storage.getUser(userId);
    await ctx.reply('🏠 *Main Menu*', {
      parse_mode: 'Markdown',
      reply_markup: keyboards.mainMenu(freshUser, settings).reply_markup,
    });

    logger.info(`User ${userId} logged in with 2FA`);
  } catch (err) {
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      waitMsg.message_id,
      null,
      `❌ Wrong 2FA password. Please try again:`,
      { reply_markup: keyboards.cancelButton('login_cancel').reply_markup }
    );
  }
  return true;
}

// ─── Cancel Login ──────────────────────────────────────────────────────────
async function cancelLogin(ctx) {
  const userId = ctx.from.id;
  await gramjs.cancelLoginSession(userId);
  await resetLogin(userId);
  clearStepTimeout(userId);
  const user = await storage.getUser(userId) || await storage.createUser(userId, ctx.from);
  const settings = await storage.getSettings();
  await ctx.reply('❌ Login cancelled.', {
    reply_markup: keyboards.mainMenu(user, settings).reply_markup,
  });
}

// ─── Logout ────────────────────────────────────────────────────────────────
async function logout(ctx) {
  const userId = ctx.from.id;

  await gramjs.stopMonitoring(userId);

  await storage.updateUser(userId, u => ({
    ...u,
    session: null,
    status: { ...u.status, loginState: LOGIN_STEPS.IDLE, loginData: {} },
    settings: { ...u.settings, alertsEnabled: false },
  }));

  logger.info(`User ${userId} logged out`);

  const settings = await storage.getSettings();
  const freshUser = await storage.getUser(userId) || await storage.createUser(userId, ctx.from);
  await ctx.reply(
    '✅ *Logged out successfully.*\n\nYour session has been cleared.',
    {
      parse_mode: 'Markdown',
      reply_markup: keyboards.mainMenu(freshUser, settings).reply_markup,
    }
  );
}

// ─── Helpers ───────────────────────────────────────────────────────────────
async function resetLogin(userId) {
  await storage.updateUser(userId, u => ({
    ...u,
    status: { ...u.status, loginState: LOGIN_STEPS.IDLE, loginData: {} },
  }));
}

function setStepTimeout(userId, ctx) {
  clearStepTimeout(userId);
  const timer = setTimeout(async () => {
    await gramjs.cancelLoginSession(userId);
    await resetLogin(userId);
    try {
      await ctx.reply('⏰ Login timed out. Please start again.', {
        reply_markup: keyboards.cancelButton('main_menu').reply_markup,
      });
    } catch (_) {}
  }, STEP_TIMEOUT);
  stepTimers.set(userId, timer);
}

function clearStepTimeout(userId) {
  const t = stepTimers.get(userId);
  if (t) { clearTimeout(t); stepTimers.delete(userId); }
}

module.exports = {
  startLogin,
  handleLoginStep,
  cancelLogin,
  logout,
  LOGIN_STEPS,
};
