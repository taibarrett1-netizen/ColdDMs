/**
 * PM2: dashboard (API + static UI), send worker (DMs), scrape worker (optional queue).
 * Usage: pm2 start ecosystem.config.cjs
 *
 * Recommended VPS env:
 *   SCRAPE_DEFER_TO_WORKER=1   — enqueue scrapes only; ig-dm-scrape runs workers/scrape-worker.js
 *   SEND_WORKER_ENTRY=workers/send-worker.js — used by dashboard "Start" to launch the sender
 *   SEND_WORKER_MIN / SEND_WORKER_MAX — bounds for getRecommendedSendWorkerInstanceCount + scripts/scale-send-workers.js
 *   npm run scale:send-workers — optional; ig-dm-dashboard auto-scales by default when Supabase is set (SCALE_SEND_WORKERS_AUTO=0 to disable)
 */
module.exports = {
  apps: [
    {
      name: 'ig-dm-dashboard',
      script: 'server.js',
      max_memory_restart: '512M',
    },
    {
      name: 'ig-dm-send',
      script: 'workers/send-worker.js',
      instances: Math.max(
        1,
        parseInt(
          process.env.SEND_WORKER_INSTANCES ||
            String(
              Math.max(
                1,
                parseInt(process.env.COLD_DM_MAX_CONCURRENT_SENDERS || process.env.COLD_DM_ACTIVE_SESSION_COUNT || '1', 10) || 1
              )
            ),
          10
        ) || 1
      ),
      exec_mode: 'cluster',
      autorestart: false,
      max_restarts: 20,
      min_uptime: 5000,
    },
    {
      name: 'ig-dm-scrape',
      script: 'workers/scrape-worker.js',
      // The worker handles concurrency internally (one job per available session,
      // up to SCRAPE_MAX_CONCURRENT).  A single instance is the right default.
      // Only raise SCRAPE_WORKER_INSTANCES if you want extra redundancy across
      // multiple VPS hosts — the session lease prevents double-claiming.
      instances: Math.max(1, parseInt(process.env.SCRAPE_WORKER_INSTANCES || '1', 10) || 1),
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '1G',
      // Set in env or .env — do not commit secrets
      env: {},
    },
  ],
};
