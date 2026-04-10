#!/usr/bin/env node
/**
 * Scale `ig-dm-send` PM2 cluster from Supabase: active clients (pause=0) and their session count.
 * Cron (every 5 min): run from repo root, e.g. `0,5,10,15,20,25,30,35,40,45,50,55 * * * * cd /path/to/Cold\ DMs\ V1 && node scripts/scale-send-workers.js`
 *
 * Flags: --dry-run (no pm2 scale)
 */
require('dotenv').config();
const { runScaleSendWorkers } = require('../lib/scaleSendWorkers');

const dryRun = process.argv.includes('--dry-run');

runScaleSendWorkers({ dryRun })
  .then((r) => {
    const line = JSON.stringify(r);
    if (r.error) {
      console.error('[scale-send-workers]', line);
      process.exit(1);
    }
    console.log('[scale-send-workers]', line);
    process.exit(0);
  })
  .catch((e) => {
    console.error('[scale-send-workers]', e);
    process.exit(1);
  });
