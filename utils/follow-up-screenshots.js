/**
 * Optional PNG screenshots during follow-up sends for debugging (e.g. "success" in logs but nothing on IG).
 * Enable with FOLLOW_UP_DEBUG_SCREENSHOTS=true in .env
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'follow-up-screenshots');
const CLICK_MARKER_ROOT_ID = '__cold_dm_click_debug__';

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isFollowUpScreenshotsEnabled() {
  const v = (process.env.FOLLOW_UP_DEBUG_SCREENSHOTS || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function fullPageScreenshots() {
  const v = (process.env.FOLLOW_UP_SCREENSHOTS_FULL_PAGE || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * @param {import('puppeteer').Page} page
 * @param {string} step - short label (e.g. thread, voice-before-send-click)
 * @param {{ correlationId?: string, logger?: { log: Function, warn: Function } }} meta
 * @returns {Promise<string|null>} absolute file path or null
 */
async function captureFollowUpScreenshot(page, step, meta = {}) {
  if (!isFollowUpScreenshotsEnabled() || !page) return null;
  const { correlationId, logger } = meta;
  try {
    if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
    const safeCorr = (correlationId || 'no-corr').replace(/[^a-zA-Z0-9-]/g, '_').slice(0, 80);
    const safeStep = String(step).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 50);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const fname = `${ts}_${safeCorr}_${safeStep}.png`;
    const fpath = path.join(DIR, fname);
    await page.screenshot({
      path: fpath,
      type: 'png',
      fullPage: fullPageScreenshots(),
    });
    const rel = path.join('follow-up-screenshots', fname);
    if (logger) logger.log(`[follow-up] debug screenshot saved ${rel}`);
    return fpath;
  } catch (e) {
    if (logger) logger.warn(`[follow-up] debug screenshot failed: ${e.message}`);
    return null;
  }
}

/**
 * Draw red crosshair + circle at viewport coordinates (same space as Puppeteer element.boundingBox()),
 * take a PNG, then remove overlay. Use with FOLLOW_UP_DEBUG_SCREENSHOTS=true.
 *
 * @param {import('puppeteer').Page} page
 * @param {Array<{ x: number, y: number, label?: string }>} markers
 * @param {string} step
 * @param {{ correlationId?: string, logger?: { log: Function, warn: Function } }} meta
 */
async function captureFollowUpScreenshotWithMarkers(page, markers, step, meta = {}) {
  if (!isFollowUpScreenshotsEnabled() || !page || !markers?.length) return null;
  const { logger } = meta;
  try {
    const payload = markers.map((m) => ({
      x: Number(m.x),
      y: Number(m.y),
      label: (m.label && String(m.label)) || '',
    }));
    await page.evaluate((points) => {
      document.getElementById('__cold_dm_click_debug__')?.remove();
      const wrap = document.createElement('div');
      wrap.id = '__cold_dm_click_debug__';
      wrap.setAttribute('data-cold-dm', 'click-debug');
      wrap.style.cssText =
        'position:fixed;inset:0;pointer-events:none;z-index:2147483647;overflow:visible;';
      for (const p of points) {
        const ring = document.createElement('div');
        ring.style.cssText = `position:absolute;left:${p.x - 18}px;top:${p.y - 18}px;width:36px;height:36px;border:3px solid #ff0000;border-radius:50%;background:rgba(255,0,0,0.2);box-sizing:border-box;`;
        wrap.appendChild(ring);
        const h = document.createElement('div');
        h.style.cssText = `position:absolute;left:${p.x - 48}px;top:${p.y - 2}px;width:96px;height:4px;background:#ff0000;`;
        wrap.appendChild(h);
        const v = document.createElement('div');
        v.style.cssText = `position:absolute;left:${p.x - 2}px;top:${p.y - 48}px;width:4px;height:96px;background:#ff0000;`;
        wrap.appendChild(v);
        if (p.label) {
          const lab = document.createElement('div');
          lab.textContent = p.label;
          lab.style.cssText = `position:absolute;left:${Math.min(p.x + 22, window.innerWidth - 220)}px;top:${Math.max(p.y - 52, 8)}px;max-width:220px;background:rgba(0,0,0,0.88);color:#fff;font:12px/1.3 system-ui,-apple-system,sans-serif;padding:6px 10px;border-radius:6px;white-space:normal;word-break:break-word;`;
          wrap.appendChild(lab);
        }
      }
      document.body.appendChild(wrap);
    }, payload);
    await delay(120);
    const out = await captureFollowUpScreenshot(page, step, meta);
    await page
      .evaluate((id) => document.getElementById(id)?.remove(), CLICK_MARKER_ROOT_ID)
      .catch(() => {});
    return out;
  } catch (e) {
    if (logger) logger.warn(`[follow-up] click-marker screenshot failed: ${e.message}`);
    await page
      .evaluate((id) => document.getElementById(id)?.remove(), CLICK_MARKER_ROOT_ID)
      .catch(() => {});
    return null;
  }
}

module.exports = {
  DIR,
  isFollowUpScreenshotsEnabled,
  captureFollowUpScreenshot,
  captureFollowUpScreenshotWithMarkers,
};
