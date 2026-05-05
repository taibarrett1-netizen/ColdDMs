/**
 * Open Instagram Web DM thread to a user (same flow as cold DM sendDMOnce navigation).
 * @returns {Promise<{ ok: true } | { ok: false, reason: string, pageSnippet?: string }>}
 */
const logger = require('./logger');
const { clickInstagramDmSearchResult, formatSearchFailurePageSnippet } = require('./instagram-dm-search');
const { gotoInstagramDirectNew } = require('./goto-instagram-direct-new');
const {
  clickElementNaturally,
  delay,
  focusAndTypeNaturally,
  organicPause,
  typeTextNaturally,
} = require('./human-interaction');

async function humanDelay(kind = 'between_actions') {
  await organicPause(kind);
}

/**
 * Instagram Web sends the composer on Enter. Puppeteer type() turns \\n into Enter → multiple DMs.
 * Use Shift+Enter between lines; caller sends with Enter once.
 */
async function typeInstagramDmPlainTextInComposer(page, composeHandle, msg, delayOpts) {
  await focusAndTypeNaturally(page, composeHandle, String(msg), {
    ...delayOpts,
    shiftEnterNewlines: true,
    clearFirst: false,
  });
}

async function typeInstagramDmPlainTextWithKeyboard(page, msg, delayOpts) {
  await typeTextNaturally(page, String(msg), {
    ...delayOpts,
    shiftEnterNewlines: true,
  });
}

async function navigateToDmThread(page, u) {
  await gotoInstagramDirectNew(page);
  await humanDelay();

  for (let i = 0; i < 3; i++) {
    const dismissed = await page.evaluate(function () {
      const dialogs = document.querySelectorAll('[role="dialog"], [role="alertdialog"]');
      for (let d = 0; d < dialogs.length; d++) {
        const txt = (dialogs[d].textContent || '').toLowerCase();
        if (txt.indexOf('save your login') !== -1 || txt.indexOf('not now') !== -1 || txt.indexOf('turn on notifications') !== -1) {
          const notNow = Array.from(dialogs[d].querySelectorAll('span, button, div[role="button"]')).find(function (el) {
            return (el.textContent || '').trim().toLowerCase() === 'not now';
          });
          if (notNow) {
            const btn = notNow.closest('[role="button"]') || notNow.closest('button') || notNow;
            if (btn) {
              btn.click();
              return true;
            }
          }
        }
      }
      return false;
    });
    if (dismissed) {
      logger.log('Dismissed direct/new prompt');
      await delay(1500);
    } else {
      break;
    }
  }

  await page
    .waitForFunction(
      () => {
        const els = document.querySelectorAll('input, textarea, [contenteditable="true"]');
        return Array.from(els).some((el) => {
          try {
            if (!el || el.disabled) return false;
            return (el.getClientRects && el.getClientRects().length > 0) || el.offsetParent !== null;
          } catch {
            return false;
          }
        });
      },
      { timeout: 8000 }
    )
    .catch(() => {});

  const searchHandle = await page.evaluateHandle(() => {
    const normalize = (s) => (s || '').toString().toLowerCase();
    const candidates = Array.from(document.querySelectorAll('input, textarea, [contenteditable="true"]')).filter((el) => {
      try {
        if (!el || el.disabled) return false;
        if (el.type === 'hidden') return false;
        if (el.getClientRects && el.getClientRects().length > 0) return true;
        if (el.offsetParent !== null) return true;
        return false;
      } catch {
        return false;
      }
    });

    const findWithHints = (predicates) => {
      for (const pred of predicates) {
        const hit = candidates.find((el) => pred(el));
        if (hit) return hit;
      }
      return null;
    };

    const searchOrTo = (el) => {
      const ph = normalize(el.placeholder);
      const aria = normalize(el.getAttribute && el.getAttribute('aria-label'));
      return ph.includes('search') || ph.includes('to:') || aria.includes('search') || aria.includes('to:');
    };

    const comboboxRole = (el) => {
      const role = normalize(el.getAttribute && el.getAttribute('role'));
      return role === 'combobox' || role === 'textbox';
    };

    const textInput = (el) => {
      if (!('tagName' in el)) return false;
      if (el.tagName === 'INPUT') return !el.type || el.type === 'text';
      if (el.tagName === 'TEXTAREA') return true;
      return !!el.isContentEditable;
    };

    const hit =
      findWithHints([searchOrTo, comboboxRole]) ||
      findWithHints([textInput]) ||
      candidates[0] ||
      null;

    return hit;
  });

  const searchEl = searchHandle.asElement();
  if (!searchEl) {
    await searchHandle.dispose().catch(() => {});
    return { ok: false, reason: 'no_compose', pageSnippet: 'Search input not found on direct/new' };
  }

  const searchMeta = await page.evaluate((el) => ({ tag: el.tagName, type: el.type || '', isCE: !!el.isContentEditable }), searchEl).catch(() => ({}));
  await clickElementNaturally(page, searchEl, { totalDurationMs: 260 }).catch(() => {});
  await organicPause('compose', 0.45);

  if (searchMeta.tag === 'INPUT' || searchMeta.tag === 'TEXTAREA' || searchMeta.isCE) {
    await focusAndTypeNaturally(page, searchEl, u, {
      clearFirst: true,
      minKeyDelay: 45,
      maxKeyDelay: 120,
    });
  } else {
    await delay(100);
    await typeTextNaturally(page, u, { minKeyDelay: 45, maxKeyDelay: 120 });
  }

  await searchEl.dispose();
  await searchHandle.dispose();
  await humanDelay('open_dm');

  const searchPick = await clickInstagramDmSearchResult(page, u).catch((e) => ({
    ok: false,
    reason: 'search_result_select_failed',
    logLine: `evaluate_threw: ${e && e.message ? e.message : String(e)}`,
  }));
  if (!searchPick.ok) {
    return {
      ok: false,
      reason: searchPick.reason || 'search_result_select_failed',
      pageSnippet: formatSearchFailurePageSnippet(u, searchPick),
    };
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
        return t === label || (t.includes('send') && t.includes('message')) || t === 'next' || t === 'chat';
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
  if (openedThread) await humanDelay('open_dm');
  await humanDelay('between_actions');

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
      await humanDelay('open_dm');
    }
  }
  await humanDelay('between_actions');

  const composeSelector = 'textarea, div[contenteditable="true"], p[contenteditable="true"], [contenteditable="true"], [role="textbox"]';
  try {
    await page.waitForSelector(composeSelector, { timeout: 20000 });
  } catch (e) {
    const bodySnippet = await page
      .evaluate(() => (document.body && document.body.innerText ? document.body.innerText : '').slice(0, 400))
      .catch(() => '');
    const lower = bodySnippet.toLowerCase();
    let reason = 'no_compose';
    if (lower.includes('this account is private') || lower.includes('account is private')) reason = 'account_private';
    else if (lower.includes("can't message") || lower.includes("can't send") || lower.includes('message request')) reason = 'messages_restricted';
    return { ok: false, reason, pageSnippet: bodySnippet.replace(/\s+/g, ' ').slice(0, 120) };
  }

  return { ok: true };
}

/**
 * Send one plain text message in the current thread (compose must be visible).
 * @param {{ idCapture?: { waitForOneIdAfter: (sinceMs: number, opts?: object) => Promise<string | null> } }} [options]
 *   When `idCapture` is from `attachInstagramSendIdCapture`, successful sends may include `instagramMessageId` (GraphQL item_id).
 */
async function sendPlainTextInThread(page, text, options = {}) {
  const msg = String(text || '').trim();
  if (!msg) return { ok: false, reason: 'empty_message' };
  const idCapture = options.idCapture;

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
  if (!compose) {
    await composeEl.dispose();
    return { ok: false, reason: 'no_compose' };
  }
  await organicPause('compose', 0.6);
  await clickElementNaturally(page, compose, { totalDurationMs: 240 });
  await typeInstagramDmPlainTextInComposer(page, compose, msg, { delay: 55 + Math.floor(Math.random() * 35) });
  await compose.dispose();
  await composeEl.dispose();
  await humanDelay('compose');
  const sendT0 = Date.now();
  await page.keyboard.press('Enter');
  await humanDelay('post_send');
  let instagramMessageId;
  if (idCapture && typeof idCapture.waitForOneIdAfter === 'function') {
    try {
      instagramMessageId = await idCapture.waitForOneIdAfter(sendT0, { timeoutMs: 12000 });
    } catch {
      /* optional */
    }
  }
  const out = { ok: true };
  if (instagramMessageId) out.instagramMessageId = instagramMessageId;
  return out;
}

/**
 * Best-effort heuristic: inspect the lowest visible text bubble above the composer and
 * classify it by horizontal position. Instagram inbound bubbles render on the left; our
 * outbound bubbles render on the right.
 */
async function getLastVisibleThreadMessageDirection(page) {
  return await page.evaluate(() => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const isVisible = (el) => {
      if (!el || typeof el.getBoundingClientRect !== 'function') return false;
      const style = window.getComputedStyle(el);
      if (!style || style.visibility === 'hidden' || style.display === 'none') return false;
      const rect = el.getBoundingClientRect();
      return rect.width >= 16 && rect.height >= 10 && rect.bottom > 0 && rect.right > 0;
    };
    const composer =
      Array.from(document.querySelectorAll('textarea, input, [contenteditable="true"], [role="textbox"]')).find((el) => {
        if (!isVisible(el)) return false;
        const hint = normalize(
          (el.getAttribute && `${el.getAttribute('placeholder') || ''} ${el.getAttribute('aria-label') || ''}`) || ''
        ).toLowerCase();
        return hint.includes('message') || hint.includes('add a message') || hint.includes('write a message');
      }) || null;
    const composerTop = composer && typeof composer.getBoundingClientRect === 'function'
      ? composer.getBoundingClientRect().top
      : window.innerHeight;
    const banned = [
      /^seen\b/i,
      /^sent\b/i,
      /^delivered\b/i,
      /^message\b/i,
      /^write a message\b/i,
      /^add a message\b/i,
      /^active\b/i,
      /^typing\b/i,
      /^\d{1,2}:\d{2}\b/,
    ];

    const candidates = [];
    const nodes = document.querySelectorAll('main div, main span, main p, main li');
    for (const el of nodes) {
      if (!isVisible(el)) continue;
      if (composer && composer.contains(el)) continue;
      if (el.closest('button, a, textarea, input, [contenteditable="true"], [role="textbox"]')) continue;
      const rect = el.getBoundingClientRect();
      if (rect.bottom > composerTop - 8) continue;
      if (rect.top < 40) continue;
      if (rect.width > window.innerWidth * 0.92 || rect.height > 220) continue;
      const text = normalize(el.textContent || el.innerText || '');
      if (!text || text.length > 280) continue;
      if (banned.some((rx) => rx.test(text))) continue;
      candidates.push({
        text,
        top: rect.top,
        bottom: rect.bottom,
        left: rect.left,
        right: rect.right,
        centerX: rect.left + rect.width / 2,
      });
    }

    if (!candidates.length) return { direction: 'unknown', text: '', confidence: 'none' };
    candidates.sort((a, b) => (b.bottom - a.bottom) || (b.top - a.top) || (b.centerX - a.centerX));
    const last = candidates[0];
    const xRatio = last.centerX / Math.max(1, window.innerWidth);
    const direction = xRatio >= 0.58 ? 'us' : xRatio <= 0.42 ? 'them' : 'unknown';
    const confidence = direction === 'unknown' ? 'low' : 'medium';
    return { direction, text: last.text, confidence, xRatio };
  });
}

module.exports = {
  getLastVisibleThreadMessageDirection,
  navigateToDmThread,
  sendPlainTextInThread,
  typeInstagramDmPlainTextInComposer,
  typeInstagramDmPlainTextWithKeyboard,
  delay,
  humanDelay,
};
