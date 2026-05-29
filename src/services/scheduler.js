/**
 * services/scheduler.js - Cron job scheduler
 * Handles: backups, bio rechecks, session heartbeats, alert count resets
 */

const cron = require('node-cron');
const logger = require('../utils/logger');
const storage = require('../utils/storage');
const verification = require('./verification');
const gramjs = require('../gramjs/client');

let scheduledJobs = [];

function startScheduler(bot) {
  // ── Auto Backup: every 6 hours ─────────────────────────────────────────
  const backupIntervalHours = parseInt(process.env.BACKUP_INTERVAL_HOURS || '6');
  const backupCron = `0 */${backupIntervalHours} * * *`;

  scheduledJobs.push(
    cron.schedule(backupCron, async () => {
      try {
        await storage.createBackup();
        logger.info('Scheduled backup completed');
      } catch (err) {
        logger.error(`Scheduled backup failed: ${err.message}`);
      }
    })
  );

  // ── Bio Verification Recheck: every 12 hours ───────────────────────────
  scheduledJobs.push(
    cron.schedule('0 */12 * * *', async () => {
      try {
        await verification.recheckAllBios();
      } catch (err) {
        logger.error(`Bio recheck failed: ${err.message}`);
      }
    })
  );

  // ── Alert Count Reset: daily at midnight ──────────────────────────────
  scheduledJobs.push(
    cron.schedule('0 0 * * *', async () => {
      try {
        const users = await storage.getAllUsers();
        for (const user of users) {
          if (!user.alertCount) continue;
          await storage.updateUser(user.id, u => ({
            ...u,
            alertCount: { ...u.alertCount, today: 0, lastResetDate: new Date().toDateString() },
          }));
        }
        logger.info('Daily alert counts reset');
      } catch (err) {
        logger.error(`Alert count reset failed: ${err.message}`);
      }
    })
  );

  // ── Session Heartbeat: every 30 minutes ───────────────────────────────
  // Check that active sessions are still connected, reconnect if needed
  scheduledJobs.push(
    cron.schedule('*/30 * * * *', async () => {
      try {
        const activeIds = gramjs.getActiveUserIds();
        for (const uid of activeIds) {
          const isActive = await gramjs.isClientActive(uid);
          if (!isActive) {
            logger.warn(`Dead session detected for ${uid}, attempting reconnect...`);
            const user = await storage.getUser(uid);
            if (user?.session && user?.settings?.alertsEnabled) {
              const onAlert = async (userId, type, alertData) => {
                const { sendAlert } = require('./alert-service');
                await sendAlert(bot, userId, type, alertData);
              };
              await gramjs.startMonitoring(uid, onAlert).catch(err => {
                logger.error(`Reconnect failed for ${uid}: ${err.message}`);
              });
            }
          }
        }
      } catch (err) {
        logger.error(`Session heartbeat error: ${err.message}`);
      }
    })
  );

  logger.info(`Scheduler started with ${scheduledJobs.length} jobs`);
}

function stopScheduler() {
  scheduledJobs.forEach(job => job.stop());
  scheduledJobs = [];
  logger.info('Scheduler stopped');
}

module.exports = { startScheduler, stopScheduler };
