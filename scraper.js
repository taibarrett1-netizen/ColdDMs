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
  getConversationParticipantUsernames,
  getPlatformScraperSessionById,
  recordScraperActions,
} = require('./database/supabase');
const logger = require('./utils/logger');
const { applyMobileEmulation } = require('./utils/mobile-viewport');

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
    await applyMobileEmulation(page);
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
  const leadGroupId = options.leadGroupId || null;
  const sb = require('./database/supabase').getSupabase();
  if (!sb || !clientId || !jobId) {
    logger.error('[Scraper] Missing clientId or jobId');
    return;
  }

  let browser;
  try {
    const job = await getScrapeJob(jobId);
    let session = null;
    let platformSessionId = null;
    if (job?.platform_scraper_session_id) {
      const platformSession = await getPlatformScraperSessionById(job.platform_scraper_session_id);
      if (platformSession) {
        session = platformSession;
        platformSessionId = job.platform_scraper_session_id;
      }
    }
    if (!session) {
      session = await getScraperSession(clientId);
    }
    if (!session?.session_data?.cookies?.length) {
      await updateScrapeJob(jobId, { status: 'failed', error_message: 'Scraper session not found or expired' });
      return;
    }

    browser = await puppeteer.launch({
      headless: HEADLESS,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();
    await applyMobileEmulation(page);
    await page.setCookie(...session.session_data.cookies);
    await page.goto('https://www.instagram.com/', { waitUntil: 'networkidle2', timeout: 30000 });
    await delay(2000);

    if (page.url().includes('/accounts/login')) {
      await updateScrapeJob(jobId, { status: 'failed', error_message: 'Scraper session expired. Reconnect scraper.' });
      return;
    }
    logger.log('[Scraper] Warming session before scrape...');
    await delay(3000 + Math.floor(Math.random() * 5000));
    for (let i = 0; i < 2 + Math.floor(Math.random() * 2); i++) {
      await page.evaluate(() => window.scrollTo(0, 200 + Math.random() * 500));
      await delay(8000 + Math.floor(Math.random() * 15000));
    }
    const liked = await page.evaluate(() => {
      const likeBtns = Array.from(document.querySelectorAll('[aria-label="Like"], svg[aria-label="Like"]')).slice(0, 2);
      for (const btn of likeBtns) {
        const el = btn.closest('button') || btn.closest('[role="button"]') || btn;
        if (el && el.offsetParent) {
          el.click();
          return true;
        }
      }
      return false;
    });
    if (liked) await delay(5000 + Math.floor(Math.random() * 10000));
    logger.log('[Scraper] Warm behaviour done.');

    const source = `followers:${targetUsername}`;
    const cleanTarget = targetUsername.replace(/^@/, '').trim().toLowerCase();
    logger.log(`[Scraper] Starting follower scrape for @${cleanTarget}${maxLeads ? ` (max ${maxLeads})` : ''}`);

    await page.goto(`https://www.instagram.com/${encodeURIComponent(cleanTarget)}/`, {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });
    await delay(randomDelay(SCRAPE_DELAY_MIN_MS, SCRAPE_DELAY_MAX_MS));

    const jobCheck = await getScrapeJob(jobId);
    if (jobCheck?.status === 'cancelled') return;

    const profileFollowerCount = await page.evaluate((target) => {
      function parseCount(str) {
        if (!str || typeof str !== 'string') return null;
        const raw = str.replace(/,/g, '').trim();
        const m = raw.match(/([\d.]+)\s*(k|m)?/i);
        if (!m) return null;
        let n = parseFloat(m[1], 10);
        if (m[2] === 'k' || m[2] === 'K') n *= 1000;
        else if (m[2] === 'm' || m[2] === 'M') n *= 1000000;
        return Math.floor(n);
      }
      const links = Array.from(document.querySelectorAll('a[href*="/followers"]'));
      const followersLink = links.find(function (a) {
        const href = (a.getAttribute('href') || '').toLowerCase();
        return href.indexOf('/' + target + '/followers') !== -1;
      });
      if (!followersLink) return null;
      const container = followersLink.closest('li') || followersLink.parentElement;
      if (!container) return null;
      const titleEl = container.querySelector('[title]');
      const span = container.querySelector('span');
      let n = parseCount((titleEl && titleEl.getAttribute('title')) || (span && span.getAttribute('title')));
      if (n != null) return n;
      const txt = (container.textContent || '').replace(/,/g, '');
      n = parseCount(txt);
      if (n != null) return n;
      n = parseCount(followersLink.getAttribute('aria-label'));
      if (n != null) return n;
      return parseCount(followersLink.textContent);
    }, cleanTarget);

    const effectiveMax =
      profileFollowerCount != null && profileFollowerCount > 0
        ? (maxLeads ? Math.min(maxLeads, profileFollowerCount) : profileFollowerCount)
        : maxLeads;
    if (profileFollowerCount != null) {
      logger.log('[Scraper] Profile has ' + profileFollowerCount + ' followers; capping at ' + effectiveMax);
    } else {
      logger.log('[Scraper] Could not parse follower count from profile; using max_leads only');
    }

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
      logger.error('[Scraper] Could not open followers modal');
      await updateScrapeJob(jobId, {
        status: 'failed',
        error_message: 'Could not open followers list. Profile may be private or link not found.',
      });
      return;
    }

    logger.log('[Scraper] Followers modal opened, extracting...');
    await delay(3000);

    const SCRAPER_DEBUG = process.env.SCRAPER_DEBUG === '1' || process.env.SCRAPER_DEBUG === 'true';

    let totalScraped = 0;
    const seenUsernames = new Set();
    let noNewCount = 0;
    const MAX_NO_NEW = 6;
    const BLACKLIST = new Set([
      'explore', 'direct', 'accounts', 'reels', 'stories', 'p', 'tv', 'tags',
      'developer', 'about', 'blog', 'jobs', 'help', 'api', 'privacy', 'terms',
    ]);
    let scrollCount = 0;

    while (true) {
      const jobCheck = await getScrapeJob(jobId);
      if (jobCheck && jobCheck.status === 'cancelled') {
        logger.log('[Scraper] Job cancelled');
        break;
      }

      const batchResult = await page.evaluate((debug) => {
        const usernames = [];
        const dialog = document.querySelector('[role="dialog"]');
        const root = dialog || document.body;

        function isInSuggestedRow(anchor) {
          var p = anchor.parentElement;
          for (var up = 0; up < 12 && p; up++) {
            var t = (p.textContent || '').toLowerCase();
            if (t.indexOf('suggested for you') !== -1 || t.indexOf('people you may know') !== -1 || t.indexOf('similar accounts') !== -1) return true;
            p = p.parentElement;
          }
          return false;
        }

        const anchors = root.querySelectorAll('a[href^="/"]');
        var debugData = debug ? { total: anchors.length, included: [], excluded: [], excludedReasons: [] } : null;

        for (var i = 0; i < anchors.length; i++) {
          var a = anchors[i];
          const href = (a.getAttribute('href') || '').trim();
          const m = href.match(/^\/([^/?#]+)\/?$/);
          if (!m) continue;
          var u = m[1].toLowerCase();
          if (!u || u.length < 2 || u.length > 30 || !/^[a-z0-9._]+$/.test(u)) continue;

          var inSuggested = isInSuggestedRow(a);
          if (inSuggested) {
            if (debugData) debugData.excluded.push(u);
            continue;
          }

          usernames.push(u);
          if (debugData && debugData.included.length < 20) debugData.included.push(u);
        }

        const deduped = [];
        for (var di = 0; di < usernames.length; di++) {
          if (deduped.indexOf(usernames[di]) === -1) deduped.push(usernames[di]);
        }
        if (debugData) {
          return { usernames: deduped, debug: debugData };
        }
        return { usernames: deduped };
      }, SCRAPER_DEBUG);

      const batch = Array.isArray(batchResult) ? batchResult : batchResult.usernames;
      if (SCRAPER_DEBUG && batchResult.debug) {
        const d = batchResult.debug;
        logger.log('[Scraper] DEBUG: total profile links=' + d.total + ', included=' + d.included.length + ', excluded (suggested)=' + d.excluded.length);
        if (d.included.length) logger.log('[Scraper] DEBUG included: ' + d.included.join(', '));
        if (d.excluded.length) logger.log('[Scraper] DEBUG excluded: ' + d.excluded.join(', '));
        if (scrollCount === 0) {
          try {
            const html = await page.evaluate(function () {
              const d = document.querySelector('[role="dialog"]');
              return d ? d.outerHTML : 'no dialog';
            });
            const fs = require('fs');
            const dumpPath = path.join(process.cwd(), 'scraper-modal-debug.html');
            fs.writeFileSync(dumpPath, html, 'utf8');
            logger.log('[Scraper] DEBUG: dumped modal HTML to ' + dumpPath);
          } catch (e) {
            logger.warn('[Scraper] DEBUG: could not dump HTML: ' + e.message);
          }
        }
      }

      let newUsernames = batch.filter(
        (u) => !seenUsernames.has(u) && !BLACKLIST.has(u) && u !== cleanTarget
      );
      const inConvos = await getConversationParticipantUsernames(clientId);
      newUsernames = newUsernames.filter((u) => !inConvos.has(u));
      newUsernames = [...new Set(newUsernames)];
      if (effectiveMax && totalScraped + newUsernames.length > effectiveMax) {
        newUsernames = newUsernames.slice(0, effectiveMax - totalScraped);
      }
      for (const u of newUsernames) seenUsernames.add(u);

      if (newUsernames.length > 0) {
        await upsertLeadsBatch(clientId, newUsernames, source, leadGroupId);
        totalScraped = seenUsernames.size;
        await updateScrapeJob(jobId, { scraped_count: totalScraped });
        noNewCount = 0;
        logger.log(`[Scraper] Batch: +${newUsernames.length} new, total ${totalScraped}`);
        if (effectiveMax && totalScraped >= effectiveMax) {
          logger.log(`[Scraper] Reached limit (${effectiveMax}). Stopping.`);
          break;
        }
      } else {
        noNewCount++;
        if (scrollCount < 3) {
          noNewCount = 0;
        }
        if (noNewCount >= MAX_NO_NEW) {
          logger.log(`[Scraper] No new usernames for ${MAX_NO_NEW} iterations. Stopping.`);
          break;
        }
      }

      scrollCount++;
      const scrolled = await page.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"]');
        if (!dialog) return false;
        const scrollables = dialog.querySelectorAll('div');
        for (const s of scrollables) {
          const style = window.getComputedStyle(s);
          const overflow = style.overflowY || style.overflow || '';
          const canScroll = s.scrollHeight > s.clientHeight;
          if ((overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay') && canScroll) {
            const prev = s.scrollTop;
            s.scrollTop = s.scrollHeight;
            return s.scrollTop !== prev || s.scrollHeight > s.clientHeight;
          }
        }
        for (const s of scrollables) {
          if (s.scrollHeight > s.clientHeight && s.clientHeight > 100) {
            s.scrollTop = s.scrollHeight;
            return true;
          }
        }
        const prev = dialog.scrollTop;
        dialog.scrollTop = dialog.scrollHeight;
        return dialog.scrollTop !== prev;
      });

      if (!scrolled) {
        logger.log('[Scraper] No more scrollable content');
        break;
      }
      await delay(randomDelay(SCRAPE_DELAY_MIN_MS, SCRAPE_DELAY_MAX_MS));

      await page.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"]');
        if (dialog) {
          const scrollables = dialog.querySelectorAll('div');
          for (const s of scrollables) {
            if (s.scrollHeight > s.clientHeight) {
              s.scrollTop = s.scrollHeight;
              break;
            }
          }
        }
      });
      await delay(800 + Math.floor(Math.random() * 1200));
    }

    await updateScrapeJob(jobId, { status: 'completed', scraped_count: totalScraped });
    logger.log(`[Scraper] Job ${jobId} completed. Scraped ${totalScraped} followers from @${cleanTarget}`);

    try {
      await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await delay(3000 + Math.floor(Math.random() * 5000));
      await page.evaluate(() => window.scrollTo(0, 200));
      await delay(5000 + Math.floor(Math.random() * 8000));
      logger.log('[Scraper] Post-scrape warm done.');
    } catch (e) {
      logger.warn('[Scraper] Post-scrape warm skipped: ' + e.message);
    }
    if (platformSessionId && totalScraped > 0) {
      const actionCount = Math.max(20, totalScraped + 10);
      await recordScraperActions(platformSessionId, actionCount).catch(() => {});
    }
  } catch (err) {
    logger.error('[Scraper] Follower scrape failed', err);
    try {
      const { updateScrapeJob: updateJob } = require('./database/supabase');
      await updateJob(jobId, {
        status: 'failed',
        error_message: (err && err.message) || String(err),
      });
    } catch (e) {
      logger.error('[Scraper] Failed to update job status', e);
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

/**
 * Extract shortcode from Instagram post URL.
 * e.g. https://www.instagram.com/p/ABC123/ -> ABC123
 */
function getShortcodeFromPostUrl(url) {
  const m = String(url || '').match(/instagram\.com\/p\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

/**
 * Run comment scrape: navigate to post URLs, extract commenter usernames.
 * @param {string} clientId
 * @param {string} jobId
 * @param {string[]} postUrls - Instagram post URLs (e.g. https://www.instagram.com/p/ABC123/)
 * @param {object} options - { maxLeads, leadGroupId }
 */
async function runCommentScrape(clientId, jobId, postUrls, options = {}) {
  const maxLeads = options.maxLeads != null ? Math.max(1, parseInt(options.maxLeads, 10) || 0) : null;
  const leadGroupId = options.leadGroupId || null;
  const sb = require('./database/supabase').getSupabase();
  if (!sb || !clientId || !jobId || !postUrls || !Array.isArray(postUrls) || postUrls.length === 0) {
    logger.error('[Scraper] Comment scrape: missing clientId, jobId, or postUrls');
    return;
  }

  const BLACKLIST = new Set([
    'explore', 'direct', 'accounts', 'reels', 'stories', 'p', 'tv', 'tags',
    'developer', 'about', 'blog', 'jobs', 'help', 'api', 'privacy', 'terms',
  ]);

  let browser;
  let platformSessionId = null;
  try {
    const job = await getScrapeJob(jobId);
    let session = null;
    if (job?.platform_scraper_session_id) {
      const platformSession = await getPlatformScraperSessionById(job.platform_scraper_session_id);
      if (platformSession) {
        session = platformSession;
        platformSessionId = job.platform_scraper_session_id;
      }
    }
    if (!session) {
      session = await getScraperSession(clientId);
    }
    if (!session?.session_data?.cookies?.length) {
      await updateScrapeJob(jobId, { status: 'failed', error_message: 'Scraper session not found or expired' });
      return;
    }

    browser = await puppeteer.launch({
      headless: HEADLESS,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();
    await applyMobileEmulation(page);
    await page.setCookie(...session.session_data.cookies);
    await page.goto('https://www.instagram.com/', { waitUntil: 'networkidle2', timeout: 30000 });
    await delay(2000);

    if (page.url().includes('/accounts/login')) {
      await updateScrapeJob(jobId, { status: 'failed', error_message: 'Scraper session expired. Reconnect scraper.' });
      return;
    }

    logger.log('[Scraper] Warming session before comment scrape...');
    await delay(3000 + Math.floor(Math.random() * 5000));
    await page.evaluate(() => window.scrollTo(0, 200 + Math.random() * 500));
    await delay(2000 + Math.floor(Math.random() * 3000));

    logger.log('[Scraper] Comment scrape: ' + postUrls.length + ' post(s)');
    let totalScraped = 0;
    const seenUsernames = new Set();
    const inConvos = await getConversationParticipantUsernames(clientId);
    const scraperUsername = (session?.instagram_username || '').trim().replace(/^@/, '').toLowerCase();
    if (scraperUsername) seenUsernames.add(scraperUsername);

    for (const postUrl of postUrls) {
      const jobCheck = await getScrapeJob(jobId);
      if (jobCheck && jobCheck.status === 'cancelled') {
        logger.log('[Scraper] Job cancelled');
        break;
      }

      const shortcode = getShortcodeFromPostUrl(postUrl);
      const normalizedUrl = postUrl.includes('instagram.com') ? postUrl : 'https://www.instagram.com/p/' + postUrl + '/';
      await page.goto(normalizedUrl, { waitUntil: 'networkidle2', timeout: 30000 });
      await delay(randomDelay(SCRAPE_DELAY_MIN_MS, SCRAPE_DELAY_MAX_MS));

      const candidateAuthors = await page.evaluate(function () {
        const blacklist = ['explore', 'direct', 'accounts', 'reels', 'stories', 'p', 'tv', 'tags'];
        const out = [];
        const anchors = document.querySelectorAll('a[href^="/"]');
        for (let i = 0; i < Math.min(anchors.length, 20); i++) {
          const href = (anchors[i].getAttribute('href') || '').trim();
          const m = href.match(/^\/([^/?#]+)\/?$/);
          if (!m) continue;
          const u = m[1].toLowerCase();
          if (u && u.length >= 2 && u.length <= 30 && /^[a-z0-9._]+$/.test(u) && blacklist.indexOf(u) === -1) {
            out.push(u);
          }
        }
        return out;
      });

      const postAuthor = candidateAuthors.find((u) => u !== scraperUsername) || null;

      if (postAuthor) {
        await updateScrapeJob(jobId, { target_username: postAuthor });
        logger.log('[Scraper] Post author: @' + postAuthor);
        seenUsernames.add(postAuthor);
      }

      const source = postAuthor ? 'comments:' + postAuthor : (shortcode ? 'comments:' + shortcode : 'comments:' + postUrl);

      let noNewCount = 0;
      let scrollCount = 0;

      while (true) {
        const usernames = await page.evaluate(function () {
          const out = [];
          const anchors = document.querySelectorAll('a[href^="/"]');
          for (let i = 0; i < anchors.length; i++) {
            const href = (anchors[i].getAttribute('href') || '').trim();
            const m = href.match(/^\/([^/?#]+)\/?$/);
            if (!m) continue;
            const u = m[1].toLowerCase();
            if (u && u.length >= 2 && u.length <= 30 && /^[a-z0-9._]+$/.test(u)) out.push(u);
          }
          return [...new Set(out)];
        });

        let newUsernames = usernames.filter(
          (u) => !seenUsernames.has(u) && !BLACKLIST.has(u) && !inConvos.has(u) && (!postAuthor || u !== postAuthor)
        );
        newUsernames = [...new Set(newUsernames)];
        if (maxLeads && totalScraped + newUsernames.length > maxLeads) {
          newUsernames = newUsernames.slice(0, maxLeads - totalScraped);
        }
        for (const u of newUsernames) seenUsernames.add(u);

        if (newUsernames.length > 0) {
          await upsertLeadsBatch(clientId, newUsernames, source, leadGroupId);
          totalScraped = seenUsernames.size;
          await updateScrapeJob(jobId, { scraped_count: totalScraped });
          noNewCount = 0;
          logger.log('[Scraper] Comments: +' + newUsernames.length + ' new, total ' + totalScraped);
          if (maxLeads && totalScraped >= maxLeads) break;
        } else {
          noNewCount++;
          if (noNewCount >= 3) break;
        }

        const commentsOpened = await page.evaluate(function () {
          const btns = Array.from(document.querySelectorAll('span, a, [role="button"]'));
          const commentBtn = btns.find(function (b) {
            const t = (b.textContent || '').toLowerCase();
            return t.includes('comment') || t === 'view all' || /^\d+\s*comment/.test(t);
          });
          if (commentBtn) {
            commentBtn.click();
            return true;
          }
          return false;
        });
        if (commentsOpened) await delay(2000);

        const scrolled = await page.evaluate(function () {
          const scrollables = document.querySelectorAll('div[style*="overflow"], [role="dialog"]');
          for (let i = 0; i < scrollables.length; i++) {
            const s = scrollables[i];
            if (s.scrollHeight > s.clientHeight) {
              s.scrollTop = s.scrollHeight;
              return true;
            }
          }
          window.scrollTo(0, document.body.scrollHeight);
          return true;
        });
        if (!scrolled) break;
        await delay(randomDelay(1500, 3000));
        scrollCount++;
        if (scrollCount > 10) break;
      }

      await delay(randomDelay(SCRAPE_DELAY_MIN_MS, SCRAPE_DELAY_MAX_MS));
    }

    try {
      await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await delay(3000 + Math.floor(Math.random() * 5000));
      await page.evaluate(() => window.scrollTo(0, 200));
      await delay(5000 + Math.floor(Math.random() * 8000));
      logger.log('[Scraper] Post-scrape warm done.');
    } catch (e) {
      logger.warn('[Scraper] Post-scrape warm skipped: ' + e.message);
    }

    if (platformSessionId && totalScraped > 0) {
      const actionCount = Math.max(20, totalScraped + 10);
      await recordScraperActions(platformSessionId, actionCount).catch(() => {});
    }

    await updateScrapeJob(jobId, { status: 'completed', scraped_count: totalScraped });
    logger.log('[Scraper] Comment job ' + jobId + ' completed. Scraped ' + totalScraped + ' leads.');
  } catch (err) {
    logger.error('[Scraper] Comment scrape failed', err);
    try {
      const { updateScrapeJob: updateJob } = require('./database/supabase');
      await updateJob(jobId, {
        status: 'failed',
        error_message: (err && err.message) || String(err),
      });
    } catch (e) {
      logger.error('[Scraper] Failed to update job status', e);
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = { connectScraper, runFollowerScrape, runCommentScrape };
