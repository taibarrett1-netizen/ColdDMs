require('dotenv').config();
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const { getRandomMessage } = require('./config/messages');
const { alreadySent, logSentMessage, getDailyStats, normalizeUsername, getControl, setControl } = require('./database/db');
const logger = require('./utils/logger');

puppeteer.use(StealthPlugin());

const DAILY_LIMIT = Math.min(parseInt(process.env.DAILY_SEND_LIMIT, 10) || 100, 200);
const MIN_DELAY_MS = (parseInt(process.env.MIN_DELAY_MINUTES, 10) || 5) * 60 * 1000;
const MAX_DELAY_MS = (parseInt(process.env.MAX_DELAY_MINUTES, 10) || 30) * 60 * 1000;
const MAX_PER_HOUR = parseInt(process.env.MAX_SENDS_PER_HOUR, 10) || 20;
const HEADLESS = process.env.HEADLESS_MODE !== 'false';

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function randomDelay(minMs, maxMs) {
  return minMs + Math.floor(Math.random() * (maxMs - minMs + 1));
}

async function humanDelay() {
  await delay(500 + Math.floor(Math.random() * 1500));
}

function getHourlySent() {
  const { db } = require('./database/db');
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const row = db.prepare('SELECT COUNT(*) as c FROM sent_messages WHERE sent_at >= ?').get(oneHourAgo);
  return row ? row.c : 0;
}

function readEnvFromFile() {
  const envPath = path.join(process.cwd(), '.env');
  const out = {};
  if (!fs.existsSync(envPath)) return out;
  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split('\n')) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) out[m[1].trim()] = m[2].trim();
  }
  return out;
}

async function login(page) {
  const env = readEnvFromFile();
  const username = env.INSTAGRAM_USERNAME || process.env.INSTAGRAM_USERNAME;
  const password = env.INSTAGRAM_PASSWORD || process.env.INSTAGRAM_PASSWORD;
  if (!username || !password) {
    throw new Error('Missing INSTAGRAM_USERNAME or INSTAGRAM_PASSWORD. Add them in the dashboard Settings and save.');
  }

  logger.log('Loading Instagram login page...');
  await page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'networkidle2', timeout: 45000 });
  const afterGotoUrl = page.url();
  const afterGotoTitle = await page.title().catch(() => '');
  logger.log(`After load: URL=${afterGotoUrl} title=${afterGotoTitle}`);
  await delay(3000);

  const userSel = 'input[name="username"]';
  const passSel = 'input[name="password"]';
  try {
    await page.waitForSelector(userSel, { timeout: 25000 });
  } catch (e) {
    const failUrl = page.url();
    const failTitle = await page.title().catch(() => '');
    const bodyText = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 500) : '').catch(() => '');
    logger.error('Username field not found', e);
    logger.log(`Page at failure: URL=${failUrl} title=${failTitle}`);
    logger.log(`Page body snippet: ${bodyText.replace(/\n/g, ' ').slice(0, 300)}`);
    throw e;
  }
  logger.log('Login form found, entering credentials...');
  await page.type(userSel, username, { delay: 80 + Math.floor(Math.random() * 60) });
  await humanDelay();
  await page.type(passSel, password, { delay: 80 + Math.floor(Math.random() * 60) });
  await humanDelay();
  await page.click('button[type="submit"]');
  await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 25000 }).catch(() => {});

  // "Save login" / "Not Now"
  try {
    const notNow = await page.$('button._a9--._a9_1');
    if (notNow) {
      await notNow.click();
      await delay(1000);
    }
  } catch (e) {}

  // Notifications "Not Now"
  try {
    const notNow2 = await page.$('button._a9--._a9_1');
    if (notNow2) await notNow2.click();
  } catch (e) {}

  await delay(2000);
  const currentUrl = page.url();
  if (currentUrl.includes('/accounts/login')) {
    throw new Error('Login may have failed; still on login page. Check credentials.');
  }
  logger.log('Logged in to Instagram.');
}

const MAX_SEND_RETRIES = 3;

async function sendDMOnce(page, u, msg) {
  await page.goto('https://www.instagram.com/direct/new/', { waitUntil: 'networkidle2', timeout: 20000 });
  await humanDelay();

  const querySel = 'input[name="queryBox"]';
  await page.waitForSelector(querySel, { timeout: 8000 });
  await page.type(querySel, u, { delay: 100 });
  await delay(1500);

  const firstUser = await page.$('div[role="button"]');
  if (!firstUser) {
    return { ok: false, reason: 'user_not_found' };
  }
  await firstUser.click();
  await delay(800);

  const nextClicked = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const nextBtn = buttons.find((b) => b.textContent.trim() === 'Next' || b.textContent.trim() === 'next');
    if (nextBtn) {
      nextBtn.click();
      return true;
    }
    return false;
  });
  if (nextClicked) await delay(1000);

  const textarea = await page.waitForSelector('textarea', { timeout: 5000 });
  if (!textarea) {
    return { ok: false, reason: 'no_compose' };
  }
  await page.type('textarea', msg, { delay: 60 + Math.floor(Math.random() * 40) });
  await humanDelay();
  await page.keyboard.press('Enter');
  await delay(1500);

  return { ok: true };
}

async function sendDM(page, username) {
  const u = normalizeUsername(username);
  if (alreadySent(u)) {
    logger.warn(`Already sent to @${u}, skipping.`);
    return { ok: false, reason: 'already_sent' };
  }

  const stats = getDailyStats();
  if (stats.total_sent >= DAILY_LIMIT) {
    logger.warn(`Daily limit reached (${DAILY_LIMIT}). Skipping.`);
    return { ok: false, reason: 'daily_limit' };
  }

  if (getHourlySent() >= MAX_PER_HOUR) {
    logger.warn(`Hourly limit reached (${MAX_PER_HOUR}). Skipping.`);
    return { ok: false, reason: 'hourly_limit' };
  }

  const msg = getRandomMessage();
  let lastError;
  for (let attempt = 1; attempt <= MAX_SEND_RETRIES; attempt++) {
    try {
      const result = await sendDMOnce(page, u, msg);
      if (result.ok) {
        logSentMessage(u, msg, 'success');
        logger.log(`Sent to @${u}: ${msg.slice(0, 30)}...`);
        return { ok: true };
      }
      if (result.reason === 'user_not_found' || result.reason === 'no_compose') {
        logSentMessage(u, msg, 'failed');
        logger.warn(`Send failed for @${u}: ${result.reason}`);
        return result;
      }
      lastError = new Error(result.reason);
    } catch (err) {
      lastError = err;
      logger.warn(`Attempt ${attempt}/${MAX_SEND_RETRIES} for @${u} failed: ${err.message}`);
      if (attempt < MAX_SEND_RETRIES) await delay(2000 + Math.floor(Math.random() * 3000));
    }
  }
  logger.error(`Error sending to @${u} after ${MAX_SEND_RETRIES} retries`, lastError);
  logSentMessage(u, msg, 'failed');
  return { ok: false, reason: lastError.message };
}

function loadLeadsFromCSV(csvPath) {
  return new Promise((resolve, reject) => {
    const leads = [];
    const fullPath = path.isAbsolute(csvPath) ? csvPath : path.join(process.cwd(), csvPath);
    if (!fs.existsSync(fullPath)) {
      return reject(new Error(`Leads file not found: ${fullPath}`));
    }
    fs.createReadStream(fullPath)
      .pipe(csv())
      .on('data', (row) => {
        const u = (row.username || row.Username || row.user || row.User || Object.values(row)[0] || '').trim();
        if (u) leads.push(u.replace(/^@/, ''));
      })
      .on('end', () => resolve(leads))
      .on('error', reject);
  });
}

async function runBot() {
  const csvPath = process.env.LEADS_CSV || 'leads.csv';
  let leads;
  try {
    leads = await loadLeadsFromCSV(csvPath);
  } catch (e) {
    logger.error('Failed to load leads', e);
    throw e;
  }

  const filtered = leads.filter((u) => !alreadySent(u));
  logger.log(`Loaded ${leads.length} leads, ${filtered.length} remaining after filtering already-sent.`);
  if (filtered.length === 0) {
    logger.log('No leads to send. Done.');
    return;
  }

  const browser = await puppeteer.launch({
    headless: HEADLESS,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  let page;
  try {
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await login(page);
  } catch (err) {
    logger.error('Setup failed', err);
    if (browser) await browser.close().catch(() => {});
    throw err;
  }

  let index = 0;

  const runOne = async () => {
    if (getControl('pause') === '1') {
      logger.log('Bot paused via control flag.');
      return;
    }
    if (index >= filtered.length) {
      logger.log('All leads processed.');
      await browser.close();
      process.exit(0);
    }

    const username = filtered[index];
    const result = await sendDM(page, username);
    if (result.ok) index += 1;

    const nextDelay = randomDelay(MIN_DELAY_MS, MAX_DELAY_MS);
    logger.log(`Next send in ${Math.round(nextDelay / 60000)} minutes.`);
    await delay(nextDelay);
    setImmediate(runOne);
  };

  const scheduleNext = () => {
    const initialDelay = randomDelay(60 * 1000, 3 * 60 * 1000);
    logger.log(`First send in ${Math.round(initialDelay / 1000)} seconds.`);
    setTimeout(runOne, initialDelay);
  };

  scheduleNext();
}

module.exports = { runBot, getDailyStats, loadLeadsFromCSV, sendDM, login };
