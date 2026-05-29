# 🤖 Telegram Monitor SaaS

A production-ready multi-user Telegram monitoring system built with Node.js.
Users log in with their Telegram account and receive real-time alerts for DMs, mentions, and replies — delivered silently via WhatsApp.

---

## ✨ Features

- **Silent Monitoring** — Monitors your account without marking messages as read
- **WhatsApp Alerts** — Alerts delivered via Admin or Personal WhatsApp
- **GramJS User Client** — Full Telegram user API integration
- **Multi-User** — Unlimited users, each with isolated sessions
- **Admin Panel** — Full control via inline keyboard UI
- **Broadcast System** — Send messages to all users with floodwait handling
- **Force Join** — Require users to join channels before using the bot
- **Bio Verification** — Require specific text in user's Telegram bio
- **Support Tickets** — Built-in ticket system with admin replies
- **Auto Backup** — Scheduled JSON backups with auto-pruning
- **JSON Storage** — No database required, file-based and portable

---

## 📁 Project Structure

```
telegram-saas/
├── src/
│   ├── index.js              # Entry point / boot sequence
│   ├── bot/
│   │   ├── bot.js            # Telegraf bot, all handlers wired
│   │   └── keyboards.js      # All inline keyboard layouts
│   ├── gramjs/
│   │   └── client.js         # GramJS monitoring client
│   ├── whatsapp/
│   │   └── manager.js        # Baileys WhatsApp manager
│   ├── handlers/
│   │   ├── login.js          # Multi-step login flow
│   │   ├── admin.js          # Admin panel handlers
│   │   └── help.js           # Help center content
│   ├── services/
│   │   ├── alert-service.js  # Alert routing + rate limiting
│   │   ├── verification.js   # Bio verify + force join + tickets
│   │   └── scheduler.js      # Cron jobs (backup, recheck, heartbeat)
│   └── utils/
│       ├── storage.js        # Safe JSON storage manager
│       └── logger.js         # Winston logger
├── config/
│   └── settings.json         # All system settings (editable from admin panel)
├── data/
│   ├── users/                # Per-user JSON files
│   ├── sessions/             # GramJS session strings
│   ├── whatsapp/             # Baileys auth per user
│   ├── logs/                 # Application logs
│   └── backups/              # Auto backups
├── .env.example
├── pm2.config.js
├── Dockerfile
└── docker-compose.yml
```

---

## 🚀 Quick Setup

### 1. Clone & Install

```bash
git clone <your-repo>
cd telegram-saas
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
nano .env
```

Fill in:
```env
BOT_TOKEN=your_bot_token_from_BotFather
ADMIN_IDS=your_telegram_user_id
```

Get your Telegram user ID: message [@userinfobot](https://t.me/userinfobot)

### 3. Run

```bash
# Development
npm run dev

# Production (direct)
npm start

# Production (PM2 - recommended)
npm install -g pm2
pm2 start pm2.config.js
pm2 save
pm2 startup
```

---

## 🐳 Docker Deployment

```bash
# Copy and edit .env
cp .env.example .env
nano .env

# Build and start
docker-compose up -d

# View logs
docker-compose logs -f
```

---

## 📱 Termux Setup (Android)

```bash
pkg update && pkg upgrade
pkg install nodejs git

git clone <your-repo>
cd telegram-saas
npm install

cp .env.example .env
nano .env

node src/index.js
```

---

## 🛡️ Admin Panel

Send `/admin` to the bot to open the admin panel.

**Available controls:**
- View user counts and system stats
- Broadcast messages to all users (with media support)
- Ban/unban/delete users
- Force logout or force verify users
- Toggle all system features ON/OFF
- Change welcome message, support username, bio text, footer
- Toggle maintenance mode
- View error logs
- Manage force join channels
- Configure bio verification

---

## 👤 User Flow

1. Start the bot → `/start`
2. Tap **Login Account** → Enter API ID, API HASH, phone, OTP
3. Tap **Start Alerts** → Monitoring begins
4. Optionally tap **Connect WhatsApp** → Scan QR → Alerts via WhatsApp
5. Configure preferences in **Alert Settings**

---

## ⚙️ Alert Settings

| Setting | Description |
|---------|-------------|
| DM Alerts | Alerts for private messages |
| Mention Alerts | Alerts when tagged in groups |
| Reply Alerts | Alerts when someone replies to you |
| Group Alerts | Alerts for all group messages |
| Silent Mode | Keeps messages unread after monitoring |
| Admin WA Mode | Alerts via central admin WhatsApp |
| Personal WA Mode | Alerts via your own WhatsApp |

---

## 🔧 Configuration

All settings are in `config/settings.json` and editable from the admin panel without restarting. This includes:

- Welcome message, footer, brand name
- Support username and contact info
- Bio verification required text
- Force join channels
- Alert message templates
- Broadcast delay settings
- Feature flags (forceJoin, bioVerification, maintenanceMode, etc.)

---

## 📋 Requirements

- Node.js 18+
- ~256MB RAM minimum (512MB recommended for multiple users)
- Internet access (VPS, cloud server, etc.)
- Telegram API credentials (from my.telegram.org)

---

## 🔐 Security Notes

- Session strings are stored locally in `data/sessions/` — keep your server secure
- Each user's session is fully isolated
- Admin-only routes are protected by `ADMIN_IDS`
- Banned users are blocked at the middleware level
- JSON writes are atomic (temp file + rename) to prevent corruption

---

## 🔮 Future-Ready Architecture

The codebase is structured for easy migration to:
- PostgreSQL (replace `storage.js`)
- Redis (caching layer)
- Web dashboard (REST API over existing services)
- Stripe/Razorpay (premium plans)
- Multiple admins (extend `ADMIN_IDS`)
- AI auto-replies (hook into `handleNewMessage`)
- Keyword alerts (extend alert type detection)

---

## 📝 License

MIT — Use freely for personal or commercial projects.
