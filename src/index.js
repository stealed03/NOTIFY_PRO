/**
 * index.js - Application entry point
 * Boot order:
 *   1. Load env
 *   2. Init storage
 *   3. Create bot
 *   4. Start static WebApp server
 *   5. Restore GramJS sessions
 *   6. Restore WhatsApp sessions
 *   7. Start scheduler
 *   8. Launch bot
 */

require('dotenv').config();
const http    = require('http');
const fs      = require('fs');
const path    = require('path');
const logger  = require('./utils/logger');
const storage = require('./utils/storage');
const gramjs  = require('./gramjs/client');
const waManager  = require('./whatsapp/manager');
const scheduler  = require('./services/scheduler');
const alertService = require('./services/alert-service');
const { createBot } = require('./bot/bot');

// ─── Validate Environment ──────────────────────────────────────────────────
function validateEnv() {
  const required = ['BOT_TOKEN'];
  const missing  = required.filter(k => !process.env[k]);
  if (missing.length > 0) {
    logger.error(`Missing required env vars: ${missing.join(', ')}`);
    process.exit(1);
  }
  if (!process.env.ADMIN_WA_NUMBER) {
    logger.warn('⚠️  ADMIN_WA_NUMBER not set — Mode B forwarding will not work.');
  }
  if (!process.env.WEBAPP_URL) {
    logger.warn('⚠️  WEBAPP_URL not set — WebApp button will not work. Set it after deploying webapp.');
  }
}

// ─── Static WebApp Server ──────────────────────────────────────────────────
function startWebAppServer() {
  const WEB_PORT  = parseInt(process.env.WEBAPP_PORT || '3000');
  const webappDir = path.join(process.cwd(), 'webapp');

  if (!fs.existsSync(webappDir)) {
    logger.warn('webapp/ folder not found — skipping static server.');
    return;
  }

  const MIME = {
    '.html': 'text/html',
    '.css':  'text/css',
    '.js':   'application/javascript',
    '.json': 'application/json',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.svg':  'image/svg+xml',
    '.ico':  'image/x-icon',
  };

  // Shared headers — allow all origins so Telegram (any platform) can load the page
  const BASE_HEADERS = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  const server = http.createServer((req, res) => {
    // Preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, BASE_HEADERS);
      res.end();
      return;
    }

    // Health check — Railway uses this to confirm the app is up
    if (req.url === '/health' || req.url === '/ping') {
      res.writeHead(200, { 'Content-Type': 'text/plain', ...BASE_HEADERS });
      res.end('OK');
      return;
    }

    // Security: strip traversal attempts
    const safePath = req.url.replace(/\.\./g, '').split('?')[0];
    const filePath = path.join(webappDir, safePath === '/' ? 'index.html' : safePath);
    const ext      = path.extname(filePath) || '.html';
    const mime     = MIME[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, data) => {
      if (err) {
        // Fallback to index.html for SPA routing
        fs.readFile(path.join(webappDir, 'index.html'), (err2, data2) => {
          if (err2) { res.writeHead(404); res.end('Not found'); return; }
          res.writeHead(200, { 'Content-Type': 'text/html', ...BASE_HEADERS });
          res.end(data2);
        });
        return;
      }
      res.writeHead(200, { 'Content-Type': mime, ...BASE_HEADERS });
      res.end(data);
    });
  });

  // IMPORTANT: bind to 0.0.0.0 — Railway rejects apps that only listen on 127.0.0.1
  server.listen(WEB_PORT, '0.0.0.0', () => {
    logger.info(`🌐 WebApp server running on 0.0.0.0:${WEB_PORT}`);
    logger.info(`   WEBAPP_URL = ${process.env.WEBAPP_URL || '(not set — set this in Railway env vars)'}`);
  });
}

// ─── Main Boot Sequence ────────────────────────────────────────────────────
async function main() {
  logger.info('═══════════════════════════════════════');
  logger.info('  TeleForward SaaS — Starting...');
  logger.info('═══════════════════════════════════════');

  validateEnv();

  logger.info('Initializing storage...');
  await storage.initStorage();

  logger.info('Creating bot...');
  const bot = createBot();

  logger.info('Starting WebApp static server...');
  startWebAppServer();

  const onAlert = async (userId, type, alertData) => {
    await alertService.sendAlert(bot, userId, type, alertData);
  };

  logger.info('Restoring Telegram monitoring sessions...');
  const restoredTG = await gramjs.restoreAllSessions(onAlert);
  logger.info(`Restored ${restoredTG} Telegram sessions`);

  logger.info('Restoring WhatsApp sessions...');
  await waManager.restoreAllSessions(bot);

  logger.info('Starting scheduler...');
  scheduler.startScheduler(bot);

  logger.info('Launching bot...');
  await bot.launch();
  logger.info('✅ Bot is live!');

  const adminIds = process.env.ADMIN_IDS?.split(',').map(Number).filter(Boolean) || [];
  if (adminIds.length > 0) {
    logger.info(`Admin IDs: ${adminIds.join(', ')}`);
  } else {
    logger.warn('⚠️  No ADMIN_IDS configured!');
  }

  logger.info('═══════════════════════════════════════');
  logger.info('  Bot is running. CTRL+C to stop.');
  logger.info('═══════════════════════════════════════');
}

// ─── Graceful Shutdown ─────────────────────────────────────────────────────
process.once('SIGINT', async () => {
  logger.info('Shutting down gracefully...');
  scheduler.stopScheduler();
  await storage.createBackup().catch(() => {});
  process.exit(0);
});
process.once('SIGTERM', async () => {
  logger.info('SIGTERM — shutting down...');
  scheduler.stopScheduler();
  await storage.createBackup().catch(() => {});
  process.exit(0);
});

process.on('unhandledRejection', (reason) => logger.error(`Unhandled rejection: ${reason}`));
process.on('uncaughtException',  (err)    => logger.error(`Uncaught exception: ${err.message}`));

main().catch(err => {
  logger.error(`Fatal startup error: ${err.message}`);
  process.exit(1);
});
