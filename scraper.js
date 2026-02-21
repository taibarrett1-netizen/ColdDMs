/**
 * Instagram scraper module – follower scrape using Puppeteer.
 * Uses cold_dm_scraper_sessions (separate from DM sender session).
 * Never stores passwords.
 */
require('dotenv').config();
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const path = require('path');
const {
  getScraperSession,
  saveScraperSession,
  createScrapeJob,
  updateScrapeJob,
  getScrapeJob,
  upsertLeadsBatch,
} = require('./database/supabase');
const logger = require('./utils/logger');

puppeteer.use(StealthPlugin());

const SCRAPE_DELAY_MIN_MS = 2000;
const SCRAPE_DELAY_MAX_MS = 5000;
const SCROLL_PAUSE_MS = 1500;
const HEADLESS = process.env.SCRAPER_HEADLESS !== 'false';

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function randomDelay(minMs, maxMs) {
  return minMs + Math.floor(Math.random() * (maxMs - minMs + 1));
}

/**
 * Log in to Instagram with credentials, return session (cookies only).
 * Password is never stored.
 */
async function connectScraper(instagramUsername, instagramPassword) {
  const browser = await puppeteer.launch({
    headless: HEADLESS,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    const { login } = require('./bot');
    await login(page, { username: instagramUsername, password: instagramPassword });
    const cookies = await page.cookies();
    return { cookies, username: instagramUsername };
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * Run follower scrape in the background. Call from API without awaiting.
 * Loads scraper session, navigates to profile, paginates followers, upserts leads.
 * @param {number} [options.maxLeads] - Optional. Stop when this many NEW leads have been added. Omit for no limit.
 */
async function runFollowerScrape(clientId, jobId, targetUsername, options = {}) {
  const maxLeads = options.maxLeads != null ? Math.max(1, parseInt(options.maxLeads, 10) || 0) : null;
  const sb = require('./database/supabase').getSupabase();
  if (!sb || !clientId || !jobId) {
    logger.error('[Scraper] Missing clientId or jobId');
    return;
  }

  let browser;
  try {
    const session = await getScraperSession(clientId);
    if (!session?.session_data?.cookies?.length) {
      await updateScrapeJob(jobId, { status: 'failed', error_message: 'Scraper session not found or expired' });
      return;
    }

    browser = await puppeteer.launch({
      headless: HEADLESS,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setCookie(...session.session_data.cookies);
    await page.goto('https://www.instagram.com/', { waitUntil: 'networkidle2', timeout: 30000 });
    await delay(2000);

    if (page.url().includes('/accounts/login')) {
      await updateScrapeJob(jobId, { status: 'failed', error_message: 'Scraper session expired. Reconnect scraper.' });
      return;
    }
    await page.evaluate(() => window.scrollTo(0, 200));
    await delay(2000 + Math.floor(Math.random() * 3000));

    const source = `followers:${targetUsername}`;
    const cleanTarget = targetUsername.replace(/^@/, '').trim().toLowerCase();
    await page.goto(`https://www.instagram.com/${encodeURIComponent(cleanTarget)}/`, {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });
    await delay(randomDelay(SCRAPE_DELAY_MIN_MS, SCRAPE_DELAY_MAX_MS));

    const job = await getScrapeJob(jobId);
    if (job?.status === 'cancelled') return;

    const followersLinkClicked = await page.evaluate((target) => {
      const links = Array.from(document.querySelectorAll('a[href*="/followers"], a[href*="/following"]'));
      const followersLink = links.find((a) => {
        const href = (a.getAttribute('href') || '').toLowerCase();
        return href.includes(`/${target}/followers`) || (href.includes('/followers') && !href.includes('/following'));
      });
      if (followersLink) {
        followersLink.click();
        return true;
      }
      const spans = Array.from(document.querySelectorAll('span'));
      const followersSpan = spans.find((s) => {
        const text = (s.textContent || '').trim();
        return /^\d+[\d,.]*(k|m)?$/.test(text) || text === 'followers';
      });
      if (followersSpan) {
        let parent = followersSpan.parentElement;
        for (let i = 0; i < 5 && parent; i++) {
          if (parent.tagName === 'A') {
            parent.click();
            return true;
          }
          parent = parent.parentElement;
        }
      }
      const roleButtons = Array.from(document.querySelectorAll('[role="button"]'));
      for (const btn of roleButtons) {
        const t = (btn.textContent || '').toLowerCase();
        if (t.includes('followers') || /\d+\s*followers/.test(t)) {
          btn.click();
          return true;
        }
      }
      return false;
    }, cleanTarget);

    if (!followersLinkClicked) {
      await updateScrapeJob(jobId, {
        status: 'failed',
        error_message: 'Could not open followers list. Profile may be private or link not found.',
      });
      return;
    }

    await delay(3000);

    let totalScraped = 0;
    const seenUsernames = new Set();
    let noNewCount = 0;
    const MAX_NO_NEW = 3;

    while (true) {
      const jobCheck = await getScrapeJob(jobId);
      if (jobCheck?.status === 'cancelled') break;

      const batch = await page.evaluate(() => {
        const usernames = [];
        const anchors = document.querySelectorAll('a[href^="/"]');
        for (const a of anchors) {
          const href = (a.getAttribute('href') || '').trim();
          const m = href.match(/^\/([^/?#]+)\/?/);
          if (m) {
            const u = m[1].toLowerCase();
            if (u && u !== 'explore' && u !== 'direct' && u !== 'accounts' && u !== 'reels' && u !== 'stories') {
              usernames.push(u);
            }
          }
        }
        return [...new Set(usernames)];
      });

      const newUsernames = batch.filter((u) => !seenUsernames.has(u));
      for (const u of newUsernames) seenUsernames.add(u);

      if (newUsernames.length > 0) {
        await upsertLeadsBatch(clientId, newUsernames, source);
        totalScraped = seenUsernames.size;
        await updateScrapeJob(jobId, { scraped_count: totalScraped });
        noNewCount = 0;
        if (maxLeads && totalScraped >= maxLeads) {
          logger.log(`[Scraper] Reached max_leads (${maxLeads}). Stopping.`);
          break;
        }
      } else {
        noNewCount++;
        if (noNewCount >= MAX_NO_NEW) break;
      }

      const scrolled = await page.evaluate(() => {
        const dialogs = document.querySelectorAll('[role="dialog"]');
        for (const d of dialogs) {
          const scrollables = d.querySelectorAll('div[style*="overflow"], div[class*="scroll"]');
          for (const s of scrollables) {
            const prev = s.scrollTop;
            s.scrollTop = s.scrollHeight;
            if (s.scrollTop !== prev || s.scrollHeight > s.clientHeight) return true;
          }
          const prev = d.scrollTop;
          d.scrollTop = d.scrollHeight;
          if (d.scrollTop !== prev || d.scrollHeight > d.clientHeight) return true;
        }
        const scrollables = document.querySelectorAll('div[style*="overflow: auto"], div[style*="overflow: scroll"]');
        for (const s of scrollables) {
          s.scrollTop = s.scrollHeight;
          return true;
        }
        return false;
      });

      if (!scrolled) break;
      await delay(randomDelay(SCRAPE_DELAY_MIN_MS, SCRAPE_DELAY_MAX_MS));
    }

    await updateScrapeJob(jobId, { status: 'completed', scraped_count: totalScraped });
    logger.log(`[Scraper] Job ${jobId} completed. Scraped ${totalScraped} followers from @${cleanTarget}`);
  } catch (err) {
    logger.error('[Scraper] Follower scrape failed', err);
    try {
      await updateScrapeJob(jobId, {
        status: 'failed',
        error_message: err.message || String(err),
      });
    } catch (e) {
      logger.error('[Scraper] Failed to update job status', e);
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = { connectScraper, runFollowerScrape };
