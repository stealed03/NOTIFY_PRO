/**
 * help.js - Help center handler
 */

const keyboards = require('../bot/keyboards');

async function showHelpMenu(ctx) {
  await ctx.editMessageText(
    '❓ *Help Center*\n\nWhat do you need help with?',
    { parse_mode: 'Markdown', reply_markup: keyboards.helpMenu().reply_markup }
  );
}

async function showHelp(ctx, topic) {
  const topics = {
    login: {
      title: '🔐 How To Login (Mode A)',
      text:
        '1. Choose *Mode A — Account Monitor* from the main menu\n' +
        '2. Tap *Login Telegram Account*\n' +
        '3. Get your API ID & Hash from https://my.telegram.org/apps\n' +
        '4. Enter API ID → API Hash → Phone Number → OTP\n' +
        '5. Done! Tap *Start Monitoring* to begin.',
    },
    forwarder: {
      title: '📲 How WA Forwarder Works (Mode B)',
      text:
        '1. Choose *Mode B — WA Forwarder* from the main menu\n' +
        '2. Tap *Connect WhatsApp* and scan the QR code\n' +
        '3. Tap *Start Forwarding*\n' +
        '4. Anyone who messages this bot → their message goes to your WhatsApp instantly!\n\n' +
        '✅ No Telegram account login needed.\n' +
        '✅ Sender name, username & ID included.',
    },
    whatsapp: {
      title: '📱 Connect WhatsApp',
      text:
        '1. Tap *Connect WhatsApp* in the main menu\n' +
        '2. A QR code will appear\n' +
        '3. Open WhatsApp → Settings → Linked Devices → Link a Device\n' +
        '4. Scan the QR code\n' +
        '5. Done! WhatsApp is now connected.',
    },
    alerts: {
      title: '🔔 How Alerts Work',
      text:
        '*Mode A (Monitor):*\n' +
        '• DM Alerts: You get notified when someone DMs you\n' +
        '• Mention Alerts: Someone mentions you in a group\n' +
        '• Reply Alerts: Someone replies to your message\n' +
        '• Silent Mode: Bot reads but keeps messages as unread\n\n' +
        '*Mode B (Forwarder):*\n' +
        '• Every message sent to your bot appears on your WhatsApp',
    },
    faq: {
      title: '❓ FAQ',
      text:
        '*Q: Is it safe to login my account?*\n' +
        'A: Yes. Your session is stored only on your own server, not shared with anyone.\n\n' +
        '*Q: What\'s the difference between Mode A and B?*\n' +
        'A: Mode A monitors your personal Telegram account. Mode B forwards messages sent to this bot to your WhatsApp.\n\n' +
        '*Q: Can I switch modes?*\n' +
        'A: Yes! Tap *Switch Mode* at the bottom of the main menu anytime.',
    },
    troubleshoot: {
      title: '🔧 Troubleshooting',
      text:
        '*Bot not responding?*\n' +
        '• Check if bot is online\n' +
        '• Try /start again\n\n' +
        '*WhatsApp not connecting?*\n' +
        '• Make sure your phone has internet\n' +
        '• Try regenerating QR\n\n' +
        '*Not getting alerts?*\n' +
        '• Make sure monitoring is active (🟢)\n' +
        '• Check Alert Settings\n' +
        '• Try sending a test alert',
    },
  };

  const t = topics[topic];
  if (!t) {
    await ctx.editMessageText('❓ Topic not found.', {
      reply_markup: keyboards.helpMenu().reply_markup,
    });
    return;
  }

  await ctx.editMessageText(
    `${t.title}\n\n${t.text}`,
    {
      parse_mode: 'Markdown',
      reply_markup: keyboards.helpMenu().reply_markup,
    }
  );
}

module.exports = { showHelpMenu, showHelp };
