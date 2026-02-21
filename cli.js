#!/usr/bin/env node
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { getDailyStats, getRecentSent, resetDailyStats } = require('./database/db');
const { loadLeadsFromCSV } = require('./bot');
const logger = require('./utils/logger');

const csvPath = process.env.LEADS_CSV || path.join(process.cwd(), 'leads.csv');

async function showStatus() {
  const stats = getDailyStats();
  let queueTotal = 0;
  let remaining = 0;
  try {
    const leads = await loadLeadsFromCSV(csvPath);
    queueTotal = leads.length;
    const { alreadySent } = require('./database/db');
    remaining = leads.filter((u) => !alreadySent(u)).length;
  } catch (e) {
    logger.warn('Could not load leads for status: ' + e.message);
  }

  logger.log('--- Status ---');
  logger.log(`Today: ${stats.total_sent} sent, ${stats.total_failed} failed.`);
  logger.log(`Leads in file: ${queueTotal}, remaining to send: ${remaining}.`);
  const recent = getRecentSent(5);
  if (recent.length) {
    logger.log('Recent:');
    recent.forEach((r) => logger.log(`  @${r.username} ${r.status} at ${r.sent_at}`));
  }
}

function doResetDaily() {
  const date = resetDailyStats();
  logger.log(`Daily stats reset for ${date}.`);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === '--status') {
    await showStatus();
    process.exit(0);
  }

  if (command === '--reset-daily') {
    doResetDaily();
    process.exit(0);
  }

  if (command === '--start' || !command) {
    const { isSupabaseConfigured } = require('./database/supabase');
    if (!isSupabaseConfigured() && !fs.existsSync(csvPath)) {
      logger.error(`Leads file not found: ${csvPath}. Create leads.csv or set LEADS_CSV in .env (or use Supabase)`);
      process.exit(1);
    }
    const { runBot } = require('./bot');
    runBot().catch((err) => {
      logger.error('Bot exited with error', err);
      process.exit(1);
    });
    return;
  }

  logger.log('Usage: node cli.js --start | --status | --reset-daily');
  process.exit(0);
}

main();
