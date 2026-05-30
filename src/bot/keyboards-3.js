/**
 * keyboards.js - All inline keyboard layouts with WebApp button
 * Mode A: Account Monitor | Mode B: WA Forwarder
 */

const { Markup } = require('telegraf');

// WebApp URL - set this to your deployed URL
// Ensures https:// prefix is always present (Telegram requires HTTPS for WebApp buttons)
const _rawUrl = process.env.WEBAPP_URL || 'https://your-webapp-url.vercel.app';
const WEBAPP_URL = _rawUrl.startsWith('http') ? _rawUrl : `https://${_rawUrl}`;

// ─── Mode Selection ────────────────────────────────────────────────────────
function modeSelectMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.url('🚀  Open TeleForward App', WEBAPP_URL)],
    [Markup.button.callback('🕵️  Mode A — Account Monitor', 'mode_select_a')],
    [Markup.button.callback('📲  Mode B — WA Message Forwarder', 'mode_select_b')],
    [Markup.button.callback('❓  What\'s the difference?', 'mode_info')],
  ]);
}

// ─── Main Menu — Mode A ────────────────────────────────────────────────────
function mainMenuA(user, settings) {
  const hasSession  = !!user?.session;
  const alertsOn    = user?.settings?.alertsEnabled;
  const waConnected = user?.whatsapp?.connected;
  const buttons     = [];

  // Top: WebApp button (always)
  buttons.push([Markup.button.url('📊  Open Dashboard', WEBAPP_URL)]);

  if (!hasSession) {
    buttons.push([Markup.button.callback('🔐  Login Telegram Account', 'login_start')]);
  } else {
    buttons.push([
      Markup.button.callback(
        alertsOn ? '🔴  Stop Monitoring' : '🟢  Start Monitoring',
        alertsOn ? 'alerts_stop' : 'alerts_start'
      ),
    ]);
    buttons.push([
      Markup.button.callback('⚙️  Alert Settings', 'alert_settings'),
      Markup.button.callback('🧪  Test Alert',     'test_alert'),
    ]);
    buttons.push([
      waConnected
        ? Markup.button.callback('📱  Disconnect WhatsApp', 'wa_disconnect')
        : Markup.button.callback('📱  Connect WhatsApp',    'wa_connect'),
      Markup.button.callback('📊  My Status', 'status_view'),
    ]);
    buttons.push([
      Markup.button.callback('👤  Account Info', 'account_info'),
      Markup.button.callback('🚪  Logout',       'logout_confirm'),
    ]);
  }

  buttons.push([
    Markup.button.callback('❓  Help',    'help_center'),
    Markup.button.callback('💬  Support', 'support_contact'),
  ]);
  buttons.push([Markup.button.callback('🔄  Switch Mode', 'switch_mode')]);

  return Markup.inlineKeyboard(buttons);
}

// ─── Main Menu — Mode B ────────────────────────────────────────────────────
// Flow: User ne bot token + WA number diya hai
//       Admin ka WA sender hai, user ke WA pe message jaata hai
function mainMenuB(user, settings) {
  const hasToken    = !!user?.forwarder?.botToken;
  const hasWaNumber = !!user?.forwarder?.waNumber;
  const forwarding  = user?.forwarder?.active;
  const buttons     = [];

  buttons.push([Markup.button.url('📊  Open Dashboard', WEBAPP_URL)]);

  if (!hasToken) {
    // Step 1: Bot token nahi diya abhi
    buttons.push([Markup.button.callback('🤖  Set Bot Token',   'forwarder_set_token')]);
    buttons.push([Markup.button.callback('ℹ️  How It Works',    'forwarder_howto')]);
  } else if (!hasWaNumber) {
    // Step 2: WA number nahi diya
    buttons.push([Markup.button.callback('📱  Set WhatsApp Number', 'forwarder_set_wa')]);
    buttons.push([Markup.button.callback('🤖  Change Bot Token',    'forwarder_set_token')]);
  } else {
    // Step 3: Sab set hai — forwarding controls
    buttons.push([
      Markup.button.callback(
        forwarding ? '🔴  Stop Forwarding' : '🟢  Start Forwarding',
        forwarding ? 'forwarder_stop'       : 'forwarder_start'
      ),
    ]);
    buttons.push([
      Markup.button.callback('📊  Stats',           'forwarder_stats'),
      Markup.button.callback('🧪  Test Forward',    'forwarder_test'),
    ]);
    buttons.push([
      Markup.button.callback('🤖  Change Token',    'forwarder_set_token'),
      Markup.button.callback('📱  Change WA No.',   'forwarder_set_wa'),
    ]);
  }

  buttons.push([
    Markup.button.callback('❓  Help',    'help_center'),
    Markup.button.callback('💬  Support', 'support_contact'),
  ]);
  buttons.push([Markup.button.callback('🔄  Switch Mode', 'switch_mode')]);

  return Markup.inlineKeyboard(buttons);
}

// ─── Generic mainMenu (auto-picks A or B) ─────────────────────────────────
function mainMenu(user, settings) {
  const mode = user?.mode;
  if (mode === 'forwarder') return mainMenuB(user, settings);
  if (mode === 'monitor')   return mainMenuA(user, settings);
  return modeSelectMenu();
}

// ─── Alert Settings ────────────────────────────────────────────────────────
function alertSettingsMenu(user) {
  const s = user.settings || {};
  const waMode = user.whatsapp?.mode || 'admin';
  const t = (v) => v ? '✅' : '❌';

  return Markup.inlineKeyboard([
    [Markup.button.url('⚙️  Open Settings App', WEBAPP_URL)],
    [
      Markup.button.callback(`${t(s.dmAlerts)} DM Alerts`,    'toggle_dm'),
      Markup.button.callback(`${t(s.mentionAlerts)} Mentions`, 'toggle_mention'),
    ],
    [
      Markup.button.callback(`${t(s.replyAlerts)} Reply Alerts`, 'toggle_reply'),
      Markup.button.callback(`${t(s.groupAlerts)} Group Alerts`, 'toggle_group'),
    ],
    [Markup.button.callback(`${t(s.silentMode)} Silent Mode`, 'toggle_silent')],
    [
      Markup.button.callback(
        waMode === 'admin'    ? '📡 Admin WA ✅'    : '📡 Admin WA',
        'wa_mode_admin'
      ),
      Markup.button.callback(
        waMode === 'personal' ? '📱 Personal WA ✅' : '📱 Personal WA',
        'wa_mode_personal'
      ),
    ],
    [Markup.button.callback('🔙  Back', 'main_menu')],
  ]);
}

// ─── Help ──────────────────────────────────────────────────────────────────
function helpMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.url('📖  Open Help Center', WEBAPP_URL)],
    [Markup.button.callback('🔐  Login Guide (Mode A)',        'help_login')],
    [Markup.button.callback('📲  WA Forwarder Guide (Mode B)', 'help_forwarder')],
    [Markup.button.callback('📱  Connect WhatsApp',            'help_whatsapp')],
    [Markup.button.callback('🔔  How Alerts Work',             'help_alerts')],
    [Markup.button.callback('❓  FAQ',                          'help_faq')],
    [Markup.button.callback('🔧  Troubleshooting',             'help_troubleshoot')],
    [Markup.button.callback('🔙  Back',                         'main_menu')],
  ]);
}

// ─── Admin Panel ───────────────────────────────────────────────────────────
function adminMenu() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('👥 Total Users',  'admin_total_users'),
      Markup.button.callback('📊 System Stats', 'admin_stats'),
    ],
    [
      Markup.button.callback('📢 Broadcast', 'admin_broadcast'),
      Markup.button.callback('👤 User Mgmt', 'admin_users'),
    ],
    [
      Markup.button.callback('🔧 Settings', 'admin_settings'),
      Markup.button.callback('📋 Logs',     'admin_logs'),
    ],
    [
      Markup.button.callback('🚧 Maintenance',  'admin_toggle_maintenance'),
      Markup.button.callback('🔗 Force Join',   'admin_forcejoin'),
    ],
    [Markup.button.callback('✅ Bio Verification', 'admin_bioverify')],
    [Markup.button.callback('📱 Admin WhatsApp (Sender)', 'admin_wa_connect')],
  ]);
}

// ─── Admin Settings ────────────────────────────────────────────────────────
function adminSettingsMenu(settings) {
  const f = settings.features || {};
  const t = (v) => v ? '✅' : '❌';

  return Markup.inlineKeyboard([
    [Markup.button.callback(`${t(f.forceJoin)}           Force Join`,         'admin_toggle_forcejoin')],
    [Markup.button.callback(`${t(f.bioVerification)}     Bio Verification`,   'admin_toggle_bioverify')],
    [Markup.button.callback(`${t(f.adminWhatsappMode)}   Admin WA Mode`,      'admin_toggle_admin_wa')],
    [Markup.button.callback(`${t(f.personalWhatsappMode)} Personal WA Mode`,  'admin_toggle_personal_wa')],
    [Markup.button.callback(`${t(f.maintenanceMode)}     Maintenance Mode`,   'admin_toggle_maintenance')],
    [Markup.button.callback('✏️ Welcome Message',    'admin_change_welcome')],
    [Markup.button.callback('✏️ Greeting (Mode B)',   'admin_change_greeting')],
    [Markup.button.callback('✏️ Confirm Message',     'admin_change_confirm')],
    [Markup.button.callback('✏️ Bot Username',        'admin_change_botuser')],
    [Markup.button.callback('✏️ Admin Username',      'admin_change_adminuser')],
    [Markup.button.callback('✏️ Bio Required Text',   'admin_change_biotext')],
    [Markup.button.callback('✏️ Footer Text',         'admin_change_footer')],
    [Markup.button.callback('✏️ Support Username',    'admin_change_support')],
    [Markup.button.callback('🔙 Back', 'admin_panel')],
  ]);
}

// ─── Admin User Menu ───────────────────────────────────────────────────────
function adminUserMenu(targetUserId) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('🚫 Ban',          `admin_ban_${targetUserId}`),
      Markup.button.callback('✅ Unban',         `admin_unban_${targetUserId}`),
    ],
    [
      Markup.button.callback('🗑 Delete',        `admin_delete_${targetUserId}`),
      Markup.button.callback('🔌 Force Logout',  `admin_forcelogout_${targetUserId}`),
    ],
    [
      Markup.button.callback('✔️ Force Verify',  `admin_forceverify_${targetUserId}`),
      Markup.button.callback('💎 Premium',        `admin_premium_${targetUserId}`),
    ],
    [Markup.button.callback('🔙 Back', 'admin_users')],
  ]);
}

// ─── Force Join ────────────────────────────────────────────────────────────
function forceJoinMenu(channels) {
  const buttons = channels.map(ch => [
    Markup.button.url(
      `📢 Join: ${ch.name || ch.id}`,
      ch.inviteLink || `https://t.me/${ch.username}`
    ),
  ]);
  buttons.push([Markup.button.callback('✅ I Joined All', 'verify_join')]);
  return Markup.inlineKeyboard(buttons);
}

// ─── Support ───────────────────────────────────────────────────────────────
function supportMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📝 Open Ticket',   'support_open_ticket')],
    [Markup.button.callback('📂 My Tickets',    'support_my_tickets')],
    [Markup.button.callback('📖 FAQ',            'help_faq')],
    [Markup.button.callback('🔙 Back',           'main_menu')],
  ]);
}

// ─── Misc ──────────────────────────────────────────────────────────────────
function cancelButton(action = 'main_menu') {
  return Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', action)]]);
}

function confirmMenu(confirmAction, cancelAction = 'main_menu', confirmLabel = '✅ Confirm', cancelLabel = '❌ Cancel') {
  return Markup.inlineKeyboard([[
    Markup.button.callback(confirmLabel, confirmAction),
    Markup.button.callback(cancelLabel,  cancelAction),
  ]]);
}

// Choice: QR or Pairing Code
function waConnectMethodMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📷  QR Code Scan',        'wa_connect_qr')],
    [Markup.button.callback('📱  Phone Number Code',   'wa_connect_pair')],
    [Markup.button.callback('❌  Cancel',              'main_menu')],
  ]);
}

function waQrMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('❌  Cancel Connection', 'wa_cancel_qr')],
  ]);
}

function waPairMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('❌  Cancel', 'wa_cancel_qr')],
  ]);
}

function verificationMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🔍 Check Verification', 'verify_bio_check')],
    [Markup.button.callback('🔙 Back',                'main_menu')],
  ]);
}

function broadcastConfirmMenu() {
  return Markup.inlineKeyboard([[
    Markup.button.callback('📢 Send to All', 'broadcast_confirm_all'),
    Markup.button.callback('❌ Cancel',       'admin_panel'),
  ]]);
}

module.exports = {
  modeSelectMenu,
  mainMenu,
  mainMenuA,
  mainMenuB,
  alertSettingsMenu,
  helpMenu,
  adminMenu,
  adminSettingsMenu,
  adminUserMenu,
  forceJoinMenu,
  supportMenu,
  cancelButton,
  confirmMenu,
  waConnectMethodMenu,
  waQrMenu,
  waPairMenu,
  verificationMenu,
  broadcastConfirmMenu,
  WEBAPP_URL,
};
