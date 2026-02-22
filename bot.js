require('dotenv').config();
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const { getRandomMessage } = require('./config/messages');
const { alreadySent, logSentMessage, getDailyStats, normalizeUsername, getControl, setControl } = require('./database/db');
const sb = require('./database/supabase');
const logger = require('./utils/logger');
const { applyMobileEmulation } = require('./utils/mobile-viewport');

puppeteer.use(StealthPlugin());

const DAILY_LIMIT = Math.min(parseInt(process.env.DAILY_SEND_LIMIT, 10) || 100, 200);
const MIN_DELAY_MS = (parseInt(process.env.MIN_DELAY_MINUTES, 10) || 5) * 60 * 1000;
const MAX_DELAY_MS = (parseInt(process.env.MAX_DELAY_MINUTES, 10) || 30) * 60 * 1000;
const MAX_PER_HOUR = parseInt(process.env.MAX_SENDS_PER_HOUR, 10) || 20;
const HEADLESS = process.env.HEADLESS_MODE !== 'false';
const BROWSER_PROFILE_DIR = path.join(process.cwd(), '.browser-profile');

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

async function login(page, credentials) {
  const username = credentials?.username ?? readEnvFromFile().INSTAGRAM_USERNAME ?? process.env.INSTAGRAM_USERNAME;
  const password = credentials?.password ?? readEnvFromFile().INSTAGRAM_PASSWORD ?? process.env.INSTAGRAM_PASSWORD;
  if (!username || !password) {
    throw new Error('Missing INSTAGRAM_USERNAME or INSTAGRAM_PASSWORD. Add them in the dashboard Settings and save.');
  }

  logger.log('Loading Instagram login page...');
  await page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'networkidle2', timeout: 45000 });
  const afterGotoUrl = page.url();
  const afterGotoTitle = await page.title().catch(() => '');
  logger.log(`After load: URL=${afterGotoUrl} title=${afterGotoTitle}`);
  await delay(3000);
  const currentUrl = page.url();
  if (!currentUrl.includes('/accounts/login')) {
    logger.log('Already logged in (session restored).');
    return;
  }

  // Instagram changes input attributes; find by type and order: first visible text input = username, first password = password
  const inputs = await page.$$('input');
  let userEl = null;
  let passEl = null;
  for (const el of inputs) {
    const props = await el.evaluate((node) => ({
      type: node.type,
      visible: node.offsetParent !== null,
    }));
    if (props.visible && (props.type === 'text' || props.type === 'email' || props.type === '')) {
      if (!userEl) userEl = el;
    } else if (props.visible && props.type === 'password') {
      passEl = el;
      break;
    }
  }
  if (!userEl || !passEl) {
    inputs.forEach((el) => el.dispose());
    const failUrl = page.url();
    const failTitle = await page.title().catch(() => '');
    const bodyText = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 500) : '').catch(() => '');
    logger.error('Login form fields not found');
    logger.log(`Page at failure: URL=${failUrl} title=${failTitle}`);
    logger.log(`Page body snippet: ${bodyText.replace(/\n/g, ' ').slice(0, 300)}`);
    throw new Error('Login form fields not found. Instagram may have changed the page.');
  }
  for (const el of inputs) {
    if (el !== userEl && el !== passEl) el.dispose();
  }
  logger.log('Login form found, entering credentials...');
  await userEl.type(username, { delay: 80 + Math.floor(Math.random() * 60) });
  await userEl.dispose();
  await humanDelay();
  await passEl.type(password, { delay: 80 + Math.floor(Math.random() * 60) });
  await passEl.dispose();
  await humanDelay();
  const clicked = await page.evaluate(() => {
    const submit = document.querySelector('button[type="submit"]');
    if (submit) {
      submit.click();
      return true;
    }
    const logIn = Array.from(document.querySelectorAll('button, [role="button"]')).find(
      (el) => el.textContent.trim() === 'Log in' && el.offsetParent !== null
    );
    if (logIn) {
      logIn.click();
      return true;
    }
    return false;
  });
  if (!clicked) throw new Error('Log in button not found.');
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
  const urlAfterLogin = page.url();
  if (urlAfterLogin.includes('/accounts/login')) {
    throw new Error('Login may have failed; still on login page. Check credentials.');
  }
  logger.log('Logged in to Instagram.');
}

const MAX_SEND_RETRIES = 3;

async function sendDMOnce(page, u, msg) {
  await page.goto('https://www.instagram.com/direct/new/', { waitUntil: 'networkidle2', timeout: 20000 });
  await humanDelay();

  const searchInput = await page.evaluateHandle(() => {
    const inputs = Array.from(document.querySelectorAll('input'));
    const visible = inputs.filter((el) => el.offsetParent !== null && el.type !== 'hidden');
    const search = visible.find(
      (el) =>
        el.placeholder && (el.placeholder.toLowerCase().includes('search') || el.placeholder.toLowerCase().includes('to:'))
    );
    if (search) return search;
    const firstText = visible.find((el) => el.type === 'text' || el.type === '' || !el.type);
    return firstText || null;
  });
  const searchEl = searchInput.asElement();
  if (!searchEl) {
    await searchInput.dispose();
    throw new Error('Search input not found on direct/new page');
  }
  await searchEl.type(u, { delay: 100 });
  await searchEl.dispose();
  await searchInput.dispose();
  await delay(1500);

  const userClicked = await page.evaluate((username) => {
    const needle = username.toLowerCase().replace(/^@/, '');
    const buttons = Array.from(document.querySelectorAll('div[role="button"]'));
    const userBtn = buttons.find((b) => {
      const t = (b.textContent || '').toLowerCase();
      return t.includes(needle) && !t.includes('more accounts');
    });
    if (userBtn) {
      userBtn.click();
      return true;
    }
    if (buttons.length) buttons[0].click();
    return false;
  }, u);
  if (!userClicked) {
    return { ok: false, reason: 'user_not_found' };
  }
  await delay(1500);

  const openedThread = await page.evaluate(() => {
    const targets = ['button', 'div[role="button"]', 'a', 'span[role="button"]'];
    const candidates = [];
    for (const sel of targets) {
      document.querySelectorAll(sel).forEach((el) => {
        if (el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0) candidates.push(el);
      });
    }
    const needle = (t) => t.toLowerCase().replace(/\s+/g, ' ').trim();
    const labels = ['send message', 'message', 'next', 'chat', 'send a message', 'start a chat'];
    for (const label of labels) {
      const btn = candidates.find((el) => {
        const t = needle(el.textContent || '');
        return t === label || (t.includes('send') && t.includes('message')) || (t === 'next') || (t === 'chat');
      });
      if (btn) {
        btn.click();
        return true;
      }
    }
    for (const label of labels) {
      const btn = candidates.find((el) => needle(el.textContent || '').includes(label));
      if (btn) {
        btn.click();
        return true;
      }
    }
    return false;
  });
  if (openedThread) await delay(2500);
  await delay(2000);

  try {
    await page.waitForFunction(
      () => !window.location.pathname.includes('/direct/new') && window.location.pathname.includes('/direct/'),
      { timeout: 8000 }
    );
  } catch (e) {
    if (page.url().includes('/direct/new')) {
      await page.evaluate(() => {
        const clickables = Array.from(document.querySelectorAll('button, div[role="button"], a'));
        const nextOrChat = clickables.find((el) => {
          const t = (el.textContent || '').toLowerCase().trim();
          return t === 'next' || t === 'chat' || (t.includes('send') && t.includes('message'));
        });
        if (nextOrChat && nextOrChat.offsetParent) nextOrChat.click();
      });
      await delay(3000);
    }
  }
  await delay(2000);

  const composeDiagnostic = () =>
    page.evaluate(() => {
      const textareas = document.querySelectorAll('textarea');
      const editables = document.querySelectorAll('div[contenteditable="true"], p[contenteditable="true"], [contenteditable="true"]');
      const roleBoxes = document.querySelectorAll('[role="textbox"]');
      const visible = (el) => el.offsetParent !== null;
      return {
        url: window.location.href,
        textarea: textareas.length,
        textareaVisible: Array.from(textareas).filter(visible).length,
        contenteditable: editables.length,
        contenteditableVisible: Array.from(editables).filter(visible).length,
        roleTextbox: roleBoxes.length,
        roleTextboxVisible: Array.from(roleBoxes).filter(visible).length,
        bodySnippet: document.body ? document.body.innerText.slice(0, 400).replace(/\n/g, ' ') : '',
      };
    });

  const composeSelector = 'textarea, div[contenteditable="true"], p[contenteditable="true"], [contenteditable="true"], [role="textbox"]';
  logger.log('Waiting for compose area...');
  let composeFound = false;
  try {
    await page.waitForSelector(composeSelector, { timeout: 20000 });
    composeFound = true;
  } catch (e) {
    const diag = await composeDiagnostic().catch(() => ({}));
    logger.warn('Compose wait failed ' + e.message);
    logger.log('Compose diagnostic: ' + JSON.stringify(diag));
  }

  if (composeFound) {
    const diag = await composeDiagnostic().catch(() => ({}));
    logger.log('Compose diagnostic: ' + JSON.stringify(diag));

    const composeEl = await page.evaluateHandle(() => {
      const byPlaceholder = (el) => {
        const p = (el.getAttribute && el.getAttribute('placeholder')) || '';
        const a = (el.getAttribute && el.getAttribute('aria-label')) || '';
        const t = (p + ' ' + a).toLowerCase();
        return t.includes('message') || t.includes('add a message') || t.includes('write a message');
      };
      const all = document.querySelectorAll('textarea, div[contenteditable="true"], p[contenteditable="true"], [contenteditable="true"], [role="textbox"]');
      for (const el of all) {
        if (el.offsetParent === null) continue;
        if (byPlaceholder(el)) return el;
      }
      for (const el of all) {
        if (el.offsetParent !== null) return el;
      }
      return null;
    });
    const compose = composeEl.asElement();
    if (compose) {
      await delay(500);
      await compose.click();
      await compose.type(msg, { delay: 60 + Math.floor(Math.random() * 40) });
      await compose.dispose();
      await composeEl.dispose();
      await humanDelay();
      await page.keyboard.press('Enter');
      await delay(1500);
      return { ok: true };
    }
    await composeEl.dispose();
    logger.warn('Compose element not found after selector matched');
  }

  const keyboardSent = await page.evaluate((text) => {
    const focusable = document.querySelector('textarea, div[contenteditable="true"], p[contenteditable="true"], [contenteditable="true"], [role="textbox"]');
    if (!focusable || focusable.offsetParent === null) return false;
    focusable.focus();
    focusable.click();
    return true;
  }, msg);
  if (keyboardSent) {
    await delay(300);
    await page.keyboard.type(msg, { delay: 60 + Math.floor(Math.random() * 40) });
    await humanDelay();
    await page.keyboard.press('Enter');
    await delay(1500);
    return { ok: true };
  }

  return { ok: false, reason: 'no_compose' };
}

async function sendDM(page, username, adapter, options = {}) {
  const { messageOverride, campaignId, campaignLeadId, messageGroupId, dailySendLimit, hourlySendLimit } = options;
  const u = normalizeUsername(username);
  const sent = await Promise.resolve(adapter.alreadySent(u));
  if (sent) {
    logger.warn(`Already sent to @${u}, skipping.`);
    if (campaignLeadId) await sb.updateCampaignLeadStatus(campaignLeadId, 'failed').catch(() => {});
    return { ok: false, reason: 'already_sent' };
  }

  const stats = await Promise.resolve(adapter.getDailyStats());
  const dailyLimit = dailySendLimit ?? adapter.dailyLimit ?? DAILY_LIMIT;
  if (stats.total_sent >= dailyLimit) {
    logger.warn(`Daily limit reached (${dailyLimit}). Skipping.`);
    return { ok: false, reason: 'daily_limit' };
  }

  const hourlySent = await Promise.resolve(adapter.getHourlySent());
  const maxPerHour = hourlySendLimit ?? adapter.maxPerHour ?? MAX_PER_HOUR;
  if (hourlySent >= maxPerHour) {
    logger.warn(`Hourly limit reached (${maxPerHour}). Skipping.`);
    return { ok: false, reason: 'hourly_limit' };
  }

  const msg = messageOverride || adapter.getRandomMessage();
  const logSent = (status) => adapter.logSentMessage(u, msg, status, campaignId, messageGroupId);

  let lastError;
  for (let attempt = 1; attempt <= MAX_SEND_RETRIES; attempt++) {
    try {
      const result = await sendDMOnce(page, u, msg);
      if (result.ok) {
        await Promise.resolve(logSent('success'));
        if (campaignLeadId) await sb.updateCampaignLeadStatus(campaignLeadId, 'sent').catch(() => {});
        logger.log(`Sent to @${u}: ${msg.slice(0, 30)}...`);
        return { ok: true };
      }
      if (result.reason === 'user_not_found' || result.reason === 'no_compose') {
        await Promise.resolve(logSent('failed'));
        if (campaignLeadId) await sb.updateCampaignLeadStatus(campaignLeadId, 'failed').catch(() => {});
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
  await Promise.resolve(logSent('failed'));
  if (campaignLeadId) await sb.updateCampaignLeadStatus(campaignLeadId, 'failed').catch(() => {});
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
  const useSupabase = sb.isSupabaseConfigured();
  const clientId = useSupabase ? sb.getClientId() : null;
  if (useSupabase && !clientId) {
    logger.error('Supabase configured but no clientId (set COLD_DM_CLIENT_ID or start via dashboard with clientId).');
    throw new Error('No clientId for Cold DM bot.');
  }

  let leads;
  let adapter;
  let getNextWork = null;
  let minDelayMs = MIN_DELAY_MS;
  let maxDelayMs = MAX_DELAY_MS;

  if (useSupabase && clientId) {
    const settings = await sb.getSettings(clientId);
    const messages = await sb.getMessageTemplates(clientId);
    leads = await sb.getLeads(clientId);
    const session = await sb.getSession(clientId);
    if (!session || !session.session_data || !session.session_data.cookies) {
      throw new Error('No Instagram session. Connect Instagram from the Cold Outreach tab first.');
    }
    if (!messages || messages.length === 0) {
      throw new Error('No message templates. Add at least one in Cold Outreach.');
    }
    minDelayMs = (settings?.min_delay_minutes ?? 5) * 60 * 1000;
    maxDelayMs = (settings?.max_delay_minutes ?? 30) * 60 * 1000;
    adapter = {
      dailyLimit: Math.min(settings?.daily_send_limit ?? 100, 200),
      maxPerHour: settings?.max_sends_per_hour ?? 20,
      alreadySent: (u) => sb.alreadySent(clientId, u),
      logSentMessage: (u, msg, status, campaignId, messageGroupId) =>
        sb.logSentMessage(clientId, u, msg, status, campaignId, messageGroupId),
      getDailyStats: () => sb.getDailyStats(clientId),
      getHourlySent: () => sb.getHourlySent(clientId),
      getControl: () => sb.getControl(clientId),
      setControl: (v) => sb.setControl(clientId, v),
      getRandomMessage: () => messages[Math.floor(Math.random() * messages.length)],
    };
    getNextWork = async () => {
      const campaign = await sb.getNextPendingCampaignLead(clientId);
      if (campaign) {
        return {
          type: 'campaign',
          username: campaign.username,
          messageOverride: campaign.messageText,
          campaignId: campaign.campaignId,
          campaignLeadId: campaign.campaignLeadId,
          messageGroupId: campaign.messageGroupId,
          dailySendLimit: campaign.dailySendLimit,
          hourlySendLimit: campaign.hourlySendLimit,
          minDelaySec: campaign.minDelaySec,
          maxDelaySec: campaign.maxDelaySec,
        };
      }
      const sentSet = await sb.getSentUsernames(clientId);
      const pending = leads.filter((u) => !sentSet.has(sb.normalizeUsername(u)));
      if (pending.length) return { type: 'lead', username: pending[0] };
      return null;
    };
    const filtered = [];
    for (const u of leads) {
      const sent = await sb.alreadySent(clientId, u);
      if (!sent) filtered.push(u);
    }
    leads = filtered;
  } else {
    const csvPath = process.env.LEADS_CSV || 'leads.csv';
    try {
      leads = await loadLeadsFromCSV(csvPath);
    } catch (e) {
      logger.error('Failed to load leads', e);
      throw e;
    }
    leads = leads.filter((u) => !alreadySent(u));
    adapter = {
      dailyLimit: DAILY_LIMIT,
      maxPerHour: MAX_PER_HOUR,
      alreadySent: (u) => alreadySent(u),
      logSentMessage: (u, msg, status, _campaignId) => logSentMessage(u, msg, status),
      getDailyStats: () => getDailyStats(),
      getHourlySent: () => getHourlySent(),
      getControl: () => getControl('pause'),
      setControl: (v) => setControl('pause', v),
      getRandomMessage: () => getRandomMessage(),
    };
  }

  if (useSupabase && clientId) {
    const work = await getNextWork();
    if (!work) {
      logger.log('No campaign leads or leads to send. Done.');
      return;
    }
  } else if (leads.length === 0) {
    logger.log('No leads to send. Done.');
    return;
  }

  logger.log(`Starting sender loop${useSupabase && clientId ? ' (campaign-aware)' : ''}.`);

  const launchOpts = {
    headless: HEADLESS,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  };
  const useSessionCookies = useSupabase && clientId;
  if (!useSessionCookies) {
    try {
      if (!fs.existsSync(BROWSER_PROFILE_DIR)) fs.mkdirSync(BROWSER_PROFILE_DIR, { recursive: true });
      launchOpts.userDataDir = BROWSER_PROFILE_DIR;
    } catch (e) {
      logger.log('Browser profile dir not used', e.message);
    }
  }
  let browser;
  try {
    browser = await puppeteer.launch(launchOpts);
  } catch (e) {
    if (launchOpts.userDataDir) {
      logger.log('Launch with profile failed, retrying without', e.message);
      delete launchOpts.userDataDir;
      browser = await puppeteer.launch(launchOpts);
    } else throw e;
  }

  let page;
  let currentSessionId = null;
  const campaignRoundRobin = new Map();

  async function ensurePageSession(page, session) {
    const cookies = session?.session_data?.cookies;
    if (!cookies?.length) return false;
    if (currentSessionId === session.id) return true;
    try {
      const existing = await page.cookies();
      if (existing.length) await page.deleteCookie(...existing);
      await page.setCookie(...cookies);
      await page.goto('https://www.instagram.com/', { waitUntil: 'networkidle2', timeout: 30000 });
      await delay(2000);
      if (page.url().includes('/accounts/login')) {
        logger.error('Instagram session expired for account ' + (session.instagram_username || session.id));
        return false;
      }
      currentSessionId = session.id;
      return true;
    } catch (e) {
      logger.error('Failed to switch session: ' + e.message);
      return false;
    }
  }

  try {
    page = await browser.newPage();
    await applyMobileEmulation(page);
    if (useSessionCookies) {
      const session = await sb.getSession(clientId);
      const cookies = session?.session_data?.cookies;
      if (cookies && cookies.length) {
        await page.setCookie(...cookies);
        if (session.id) currentSessionId = session.id;
      }
      await page.goto('https://www.instagram.com/', { waitUntil: 'networkidle2', timeout: 30000 });
      await delay(2000);
      const url = page.url();
      if (url.includes('/accounts/login')) {
        throw new Error('Instagram session expired. Reconnect from Cold Outreach.');
      }
      logger.log('Using session from Supabase.');
    } else {
      await login(page);
    }
  } catch (err) {
    logger.error('Setup failed', err);
    if (browser) await browser.close().catch(() => {});
    throw err;
  }

  let index = 0;
  const runOne = async () => {
    const pause = await Promise.resolve(adapter.getControl());
    if (pause === '1' || pause === 1) {
      logger.log('Bot paused via control flag. Rechecking in 30s.');
      setTimeout(runOne, 30000);
      return;
    }
    let work;
    if (getNextWork) {
      work = await getNextWork();
      if (!work) {
        logger.log('All campaign leads and leads processed.');
        await browser.close();
        process.exit(0);
      }
    } else {
      if (index >= leads.length) {
        logger.log('All leads processed.');
        await browser.close();
        process.exit(0);
      }
      work = { type: 'lead', username: leads[index] };
    }
    const options =
      work.type === 'campaign'
        ? {
            messageOverride: work.messageOverride,
            campaignId: work.campaignId,
            campaignLeadId: work.campaignLeadId,
            messageGroupId: work.messageGroupId,
            dailySendLimit: work.dailySendLimit,
            hourlySendLimit: work.hourlySendLimit,
            minDelaySec: work.minDelaySec,
            maxDelaySec: work.maxDelaySec,
          }
        : {};

    if (work.type === 'campaign' && useSessionCookies && clientId) {
      const sessions = await sb.getSessionsForCampaign(clientId, work.campaignId);
      if (sessions.length === 0) {
        logger.warn('No sessions for campaign ' + work.campaignId + ', skipping lead.');
        await sb.updateCampaignLeadStatus(work.campaignLeadId, 'failed').catch(() => {});
        setImmediate(runOne);
        return;
      }
      let state = campaignRoundRobin.get(work.campaignId);
      if (!state) {
        state = { lastIndex: -1 };
        campaignRoundRobin.set(work.campaignId, state);
      }
      state.lastIndex = (state.lastIndex + 1) % sessions.length;
      const session = sessions[state.lastIndex];
      const ok = await ensurePageSession(page, session);
      if (!ok) {
        logger.warn('Could not load session for campaign, failing lead.');
        await sb.updateCampaignLeadStatus(work.campaignLeadId, 'failed').catch(() => {});
        setImmediate(runOne);
        return;
      }
    }

    const result = await sendDM(page, work.username, adapter, options);
    if (result.ok && !getNextWork) index += 1;

    const delayMs =
      work.type === 'campaign' && work.minDelaySec != null && work.maxDelaySec != null
        ? randomDelay(work.minDelaySec * 1000, work.maxDelaySec * 1000)
        : randomDelay(minDelayMs, maxDelayMs);
    logger.log(`Next send in ${Math.round(delayMs / 60000)} minutes.`);
    await delay(delayMs);
    setImmediate(runOne);
  };

  await Promise.resolve(adapter.setControl(0));

  const scheduleNext = () => {
    const initialDelay = randomDelay(5 * 1000, 60 * 1000);
    logger.log(`First send in ${Math.round(initialDelay / 1000)} seconds.`);
    setTimeout(runOne, initialDelay);
  };

  scheduleNext();
}

/**
 * One-time connect: log in with given credentials and return session (cookies).
 * Used by POST /api/instagram/connect. Password is never stored.
 */
async function connectInstagram(instagramUsername, instagramPassword) {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    await applyMobileEmulation(page);
    await login(page, { username: instagramUsername, password: instagramPassword });
    const cookies = await page.cookies();
    return { cookies, username: instagramUsername };
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { runBot, getDailyStats, loadLeadsFromCSV, sendDM, login, connectInstagram };
