// pm2.config.js - PM2 process manager configuration
module.exports = {
  apps: [
    {
      name: 'telegram-saas',
      script: 'src/index.js',
      instances: 1,           // Single instance (GramJS sessions are stateful)
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      restart_delay: 3000,    // Wait 3s before restart
      max_restarts: 10,
      env: {
        NODE_ENV: 'production',
        LOG_LEVEL: 'info',
      },
      env_development: {
        NODE_ENV: 'development',
        LOG_LEVEL: 'debug',
      },
      error_file: 'data/logs/pm2-error.log',
      out_file: 'data/logs/pm2-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
