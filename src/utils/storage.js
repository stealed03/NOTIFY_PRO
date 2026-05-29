/**
 * storage.js - Safe async JSON storage manager
 */

const fs   = require('fs').promises;
const path = require('path');
const logger = require('./logger');

const writeLocks = new Map();

const PATHS = {
  users:    path.join(process.cwd(), 'data/users'),
  sessions: path.join(process.cwd(), 'data/sessions'),
  whatsapp: path.join(process.cwd(), 'data/whatsapp'),
  logs:     path.join(process.cwd(), 'data/logs'),
  backups:  path.join(process.cwd(), 'data/backups'),
  config:   path.join(process.cwd(), 'config'),
};

async function initStorage() {
  for (const [name, dirPath] of Object.entries(PATHS)) {
    await fs.mkdir(dirPath, { recursive: true });
    logger.debug(`Storage dir ready: ${name}`);
  }
}

async function acquireLock(filePath) {
  while (writeLocks.get(filePath)) {
    await new Promise(r => setTimeout(r, 10));
  }
  writeLocks.set(filePath, true);
}

function releaseLock(filePath) { writeLocks.delete(filePath); }

async function readJSON(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    if (err instanceof SyntaxError) {
      logger.error(`Corrupted JSON at ${filePath}`);
      return null;
    }
    throw err;
  }
}

async function writeJSON(filePath, data) {
  const tmpPath = filePath + '.tmp';
  await acquireLock(filePath);
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf8');
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    logger.error(`Failed to write JSON: ${err.message}`);
    try { await fs.unlink(tmpPath); } catch (_) {}
    throw err;
  } finally {
    releaseLock(filePath);
  }
}

// ─── User CRUD ─────────────────────────────────────────────────────────────
function userPath(userId) {
  return path.join(PATHS.users, `${userId}.json`);
}

async function createUser(userId, telegramData = {}) {
  const existing = await getUser(userId);
  if (existing) return existing;

  const user = {
    id: userId,
    mode: null,
    telegram: {
      username:  telegramData.username  || null,
      firstName: telegramData.first_name || null,
      lastName:  telegramData.last_name  || null,
      phone:     null,
    },
    session: null,
    settings: {
      alertsEnabled:  false,
      dmAlerts:       true,
      mentionAlerts:  true,
      replyAlerts:    true,
      groupAlerts:    false,
      silentMode:     false,
    },
    forwarder: {
      active:         false,
      totalForwarded: 0,
      todayForwarded: 0,
      lastReset:      new Date().toDateString(),
    },
    whatsapp: {
      connected: false,
      number:    null,
      mode:      'admin',
    },
    alertCount: { total: 0, today: 0, lastResetDate: new Date().toDateString() },
    status: {
      banned:     false,
      joinedAt:   new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      loginState: 'idle',
      loginData:  {},
    },
    premium:      { active: false },
    verification: { status: false },
    support:      { tickets: [] },
  };

  await writeJSON(userPath(userId), user);
  return user;
}

async function getUser(userId) {
  return await readJSON(userPath(userId));
}

async function updateUser(userId, updater) {
  const user = await getUser(userId) || await createUser(userId);
  const updated = updater(user);
  await writeJSON(userPath(userId), updated);
  return updated;
}

async function getAllUsers() {
  try {
    const files = await fs.readdir(PATHS.users);
    const users = [];
    for (const file of files) {
      if (!file.endsWith('.json') || file.endsWith('.tmp')) continue;
      const u = await readJSON(path.join(PATHS.users, file));
      if (u) users.push(u);
    }
    return users;
  } catch (_) { return []; }
}

async function deleteUser(userId) {
  try { await fs.unlink(userPath(userId)); } catch (_) {}
}

// ─── Settings ──────────────────────────────────────────────────────────────
const SETTINGS_PATH = path.join(process.cwd(), 'config/settings.json');

const DEFAULT_SETTINGS = {
  bot: {
    welcomeMessage: null,
    footerText: 'Powered by TeleForward',
    supportUsername: null,
  },
  features: {
    forceJoin:           false,
    bioVerification:     false,
    adminWhatsappMode:   true,
    personalWhatsappMode: true,
    maintenanceMode:     false,
  },
  forwarder: {
    autoReply:     false,
    autoReplyText: '✅ Message received! We\'ll get back to you soon.',
  },
  forceJoin: { channels: [] },
  alerts: {
    rateLimit: { maxPerMinute: 10, maxPerHour: 100 },
    templates: {},
  },
};

async function getSettings() {
  const saved = await readJSON(SETTINGS_PATH);
  return { ...DEFAULT_SETTINGS, ...saved };
}

async function updateSettings(updater) {
  const current = await getSettings();
  const updated = updater(current);
  await writeJSON(SETTINGS_PATH, updated);
  return updated;
}

// ─── Backup ────────────────────────────────────────────────────────────────
async function createBackup() {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = path.join(PATHS.backups, timestamp);
    await fs.mkdir(backupDir, { recursive: true });

    const files = await fs.readdir(PATHS.users);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      await fs.copyFile(
        path.join(PATHS.users, file),
        path.join(backupDir, file)
      );
    }
    logger.info(`Backup created: ${timestamp}`);
  } catch (err) {
    logger.error(`Backup failed: ${err.message}`);
  }
}

module.exports = {
  initStorage,
  createUser,
  getUser,
  updateUser,
  getAllUsers,
  deleteUser,
  getSettings,
  updateSettings,
  createBackup,
};
