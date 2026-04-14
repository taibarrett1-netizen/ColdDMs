/**
 * Instagram Web /direct/new — pick the search result row for a handle.
 * Injected into the page via page.evaluate (must stay self-contained).
 */

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * @returns {Promise<{
 *   ok: boolean,
 *   reason?: string,
 *   detail?: string,
 *   logLine?: string,
 *   displayName?: string | null,
 * }>}
 */
async function clickInstagramDmSearchResult(page, username) {
  const u = String(username || '').trim().replace(/^@/, '');
  if (!u) {
    return { ok: false, reason: 'search_result_select_failed', detail: 'empty_username', logLine: 'empty username' };
  }

  const pick = await page.evaluate((needleRaw) => {
    const needle = needleRaw.toLowerCase();
    const needleEsc = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const needleTokenRe = new RegExp(`(^|[^a-z0-9._])@?${needleEsc}([^a-z0-9._]|$)`, 'i');
    const body = document.body && document.body.innerText ? document.body.innerText : '';
    const lowerBody = body.toLowerCase();

    const igExplicitEmpty =
      lowerBody.includes("couldn't find") ||
      lowerBody.includes('could not find') ||
      lowerBody.includes('no results') ||
      lowerBody.includes('no users found') ||
      lowerBody.includes('no user found');

    function visible(el) {
      try {
        if (!el || el.disabled) return false;
        const r = el.getClientRects();
        if (!r || !r.length) return false;
        return r[0].width > 0 && r[0].height > 0;
      } catch {
        return false;
      }
    }

    function combinedMatchText(el) {
      const text = el.innerText || el.textContent || '';
      const bits = [text, el.getAttribute('aria-label') || '', el.getAttribute('title') || ''];
      return bits.join('\n').toLowerCase();
    }

    function isReservedPathSegment(seg) {
      const bad = new Set(['direct', 'p', 'reel', 'reels', 'stories', 'explore', 'accounts', 'legal', 'api', 'tv']);
      return !seg || bad.has(seg.toLowerCase());
    }

    function hrefProfileUsername(href) {
      if (!href || typeof href !== 'string') return null;
      if (!href.toLowerCase().includes('instagram.com')) return null;
      try {
        const path = new URL(href, 'https://www.instagram.com').pathname.replace(/^\/+|\/+$/g, '');
        const first = path.split('/')[0] || '';
        if (!first || isReservedPathSegment(first)) return null;
        return decodeURIComponent(first).replace(/^@/, '').toLowerCase();
      } catch {
        return null;
      }
    }

    function hrefMatches(href) {
      return hrefProfileUsername(href) === needle;
    }

    function resolveInstagramHref(el) {
      if (!el) return '';
      if (el.href && String(el.href).includes('instagram.com')) return el.href;
      const inner = el.querySelector && el.querySelector('a[href*="instagram.com"]');
      if (inner && inner.href) return inner.href;
      const a = el.closest && el.closest('a[href*="instagram.com"]');
      return a && a.href ? a.href : '';
    }

    function isChromeOnlyRow(el) {
      const raw = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const shortNav = /^(back|next|close|cancel|done|ok|chat|not now|compose|skip|new message|new|clear search|send message)$/i;
      if (raw.length <= 2) return true;
      if (raw.length <= 48 && shortNav.test(raw)) return true;
      return false;
    }

    function rowLooksLikeSearchHit(el) {
      if (isChromeOnlyRow(el)) return false;
      const c = combinedMatchText(el);
      if (c.includes('more accounts')) return false;
      return needleTokenRe.test(c);
    }

    function extractDisplayNameFromRow(el) {
      const rawText = (el.innerText || el.textContent || '').replace(/\r/g, '').trim();
      const lines = rawText
        .split(/\n+/)
        .map((s) => s.replace(/\s+/g, ' ').trim())
        .filter(Boolean);

      const userIdx = lines.findIndex((l) => l.toLowerCase().replace(/^@/, '') === needle);
      if (userIdx > 0) {
        const candidate = lines[userIdx - 1];
        if (
          candidate &&
          candidate.toLowerCase() !== 'more accounts' &&
          candidate.length >= 1 &&
          candidate.length <= 120
        ) {
          return candidate;
        }
      }
      return null;
    }

    function rowCenterY(el) {
      try {
        const r = el.getBoundingClientRect();
        return r.top + r.height / 2;
      } catch {
        return Number.POSITIVE_INFINITY;
      }
    }

    function inSearchUiShell(el) {
      let n = el;
      for (let i = 0; i < 20 && n; i++) {
        if (n.matches) {
          if (n.matches('[role="dialog"]')) return true;
          if (n.matches('[role="listbox"]')) return true;
          if (n.matches('[role="presentation"]')) return true;
          if (n.getAttribute && n.getAttribute('role') === 'combobox') return true;
          if (n.getAttribute && n.getAttribute('aria-modal') === 'true') return true;
        }
        n = n.parentElement;
      }
      return false;
    }

    function nearestMoreAccountsHeadingY() {
      const headings = Array.from(document.querySelectorAll('*')).filter((el) => {
        if (!visible(el)) return false;
        const t = (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
        return t === 'more accounts';
      });
      if (!headings.length) return null;
      let best = null;
      for (const h of headings) {
        const y = rowCenterY(h);
        if (!Number.isFinite(y)) continue;
        if (best == null || y < best) best = y;
      }
      return best;
    }

    const moreAccountsY = nearestMoreAccountsHeadingY();

    const allProfileAnchorsForDiag = Array.from(document.querySelectorAll('a[href*="instagram.com"]')).filter(visible);
    const profileHrefHits = allProfileAnchorsForDiag.filter((a) => hrefMatches(a.href));

    function collectCandidates() {
      const selectors = [
        '[role="listbox"] [role="option"]',
        '[role="listbox"] a[href*="instagram.com"]',
        '[role="listbox"] div[role="button"]',
        '[role="presentation"] [role="option"]',
        'div[role="dialog"] [role="option"]',
        'div[role="dialog"] a[href*="instagram.com/"]',
        'div[role="dialog"] div[role="button"]',
        '[role="listitem"] a[href*="instagram.com"]',
        'div[role="button"]',
        'button',
      ];
      const seen = new Set();
      const out = [];
      for (const sel of selectors) {
        let nodes;
        try {
          nodes = document.querySelectorAll(sel);
        } catch {
          continue;
        }
        for (let i = 0; i < nodes.length; i++) {
          const el = nodes[i];
          if (!el || seen.has(el)) continue;
          if (!visible(el)) continue;
          seen.add(el);
          out.push(el);
        }
      }
      return out;
    }

    function sortByMoreAccounts(arr) {
      return [...arr].sort((a, b) => {
        const ay = rowCenterY(a);
        const by = rowCenterY(b);
        if (moreAccountsY != null) {
          const aInMore = ay > moreAccountsY + 8 ? 1 : 0;
          const bInMore = by > moreAccountsY + 8 ? 1 : 0;
          if (aInMore !== bInMore) return bInMore - aInMore;
        }
        return ay - by;
      });
    }

    // ── Pass 0: any visible profile <a> whose path matches (IG often omits [role=listbox]) ──
    if (profileHrefHits.length) {
      let ranked = [...profileHrefHits];
      const inOverlay = ranked.filter(inSearchUiShell);
      if (inOverlay.length) ranked = inOverlay.sort((a, b) => rowCenterY(a) - rowCenterY(b));
      else if (moreAccountsY != null) {
        const below = ranked.filter((a) => rowCenterY(a) > moreAccountsY + 6);
        if (below.length) ranked = below.sort((a, b) => rowCenterY(a) - rowCenterY(b));
        else ranked = ranked.sort((a, b) => a.getBoundingClientRect().height - b.getBoundingClientRect().height);
      } else {
        ranked = ranked.sort((a, b) => {
          const ao = inSearchUiShell(a) ? 0 : 1;
          const bo = inSearchUiShell(b) ? 0 : 1;
          if (ao !== bo) return ao - bo;
          return rowCenterY(a) - rowCenterY(b);
        });
      }
      const pickA = ranked[0];
      const rowEl = pickA.closest && (pickA.closest('[role="option"]') || pickA.closest('[role="listitem"]') || pickA.closest('li'));
      const displayName = extractDisplayNameFromRow(rowEl || pickA);
      pickA.click();
      return { ok: true, detail: 'global_profile_href', displayName: displayName || null };
    }

    const candidates = collectCandidates();
    const sorted = sortByMoreAccounts(candidates);

    const byHref = sorted.find((el) => {
      const h = resolveInstagramHref(el);
      return h && hrefMatches(h);
    });
    if (byHref) {
      const displayName = extractDisplayNameFromRow(byHref);
      let clickTarget = byHref;
      if (byHref.tagName !== 'A') {
        const inner = byHref.querySelector && byHref.querySelector('a[href*="instagram.com"]');
        const outer = byHref.closest && byHref.closest('a[href*="instagram.com"]');
        clickTarget = inner || outer || byHref;
      }
      clickTarget.click();
      return { ok: true, detail: 'href_match', displayName: displayName || null };
    }

    const byText = sorted.find((el) => rowLooksLikeSearchHit(el));
    if (byText) {
      const displayName = extractDisplayNameFromRow(byText);
      byText.click();
      return { ok: true, detail: 'text_token_match', displayName: displayName || null };
    }

    const listbox = document.querySelector('[role="listbox"]');
    const optionSample = listbox
      ? Array.from(listbox.querySelectorAll('[role="option"], a, div[role="button"]'))
          .filter(visible)
          .slice(0, 5)
          .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 56))
          .filter(Boolean)
      : [];

    const btnSample = Array.from(document.querySelectorAll('div[role="button"]'))
      .filter(visible)
      .slice(0, 8)
      .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 48))
      .filter(Boolean);

    if (lowerBody.includes('this account is private') || lowerBody.includes('account is private') || lowerBody.includes('private account')) {
      return { ok: false, reason: 'account_private', detail: 'page_text_during_search', logLine: `handle=${needleRaw}; private_hint_in_body=true` };
    }
    if (lowerBody.includes('try again later') || lowerBody.includes('too many')) {
      return { ok: false, reason: 'rate_limited', detail: 'page_text_during_search', logLine: `handle=${needleRaw}; rate_limit_hint_in_body=true` };
    }

    function needleInSearchFields() {
      let found = false;
      try {
        document.querySelectorAll('input, textarea, [contenteditable="true"]').forEach((el) => {
          const v = (el.value != null ? String(el.value) : el.innerText != null ? el.innerText : '').toLowerCase();
          if (v.includes(needle)) found = true;
        });
      } catch {
        /* ignore */
      }
      return found;
    }

    const needleInBody = lowerBody.includes(needle);
    const needleInInputs = needleInSearchFields();
    const modalHints = [];
    if (/turn on notifications/i.test(body)) modalHints.push('notifications_prompt');
    if (/\bnot now\b/i.test(body)) modalHints.push('not_now_visible');
    if (/new message/i.test(lowerBody)) modalHints.push('new_message_chrome');

    let reason = 'search_result_select_failed';
    let detail = 'no_clickable_match';

    if (igExplicitEmpty && !needleInBody && !needleInInputs) {
      reason = 'user_not_found';
      detail = 'instagram_empty_state';
    } else if (igExplicitEmpty && (needleInBody || needleInInputs)) {
      reason = 'user_not_found';
      detail = 'instagram_says_empty_but_handle_appears_in_page_text';
    }

    const parts = [
      `handle=${needleRaw}`,
      `reason=${reason}`,
      `detail=${detail}`,
      `igSaysNoResults=${igExplicitEmpty}`,
      `handleInBody=${needleInBody}`,
      `handleInSearchFields=${needleInInputs}`,
      listbox ? `listboxSample=${optionSample.join(' | ') || '(none)'}` : 'listbox=absent',
      `divRoleButtonSample=${btnSample.join(' | ') || '(none)'}`,
      modalHints.length ? `modalHints=${modalHints.join(',')}` : 'modalHints=(none)',
      `profileAnchorsMatchingHref=${profileHrefHits.length}`,
    ];
    return { ok: false, reason, detail, logLine: parts.join('; ') };
  }, u);

  if (pick && pick.ok) return pick;
  if (pick && pick.reason && ['user_not_found', 'account_private', 'rate_limited'].includes(pick.reason)) {
    return pick;
  }

  const stillOnNew = await page.evaluate(() => {
    try {
      return /\/direct\/new\/?$/i.test(window.location.pathname || '');
    } catch {
      return false;
    }
  });
  if (!stillOnNew) return pick;

  for (let steps = 1; steps <= 5; steps++) {
    for (let s = 0; s < steps; s++) {
      await page.keyboard.press('ArrowDown').catch(() => {});
      await delay(110);
    }
    await page.keyboard.press('Enter').catch(() => {});
    await delay(950);
    const navigated = await page.evaluate(() => {
      try {
        return /\/direct\/t\//.test(window.location.pathname || '');
      } catch {
        return false;
      }
    });
    if (navigated) {
      return { ok: true, detail: `keyboard_${steps}_arrows_enter`, displayName: null };
    }
  }

  return pick;
}

/**
 * Human-readable line for logs / pageSnippet when search selection fails.
 * @param {string} username
 * @param {{ reason?: string, logLine?: string, detail?: string }} pick
 */
function formatSearchFailurePageSnippet(username, pick) {
  const u = String(username || '').trim().replace(/^@/, '');
  const diag = pick.logLine || pick.detail || '';
  if (pick.reason === 'user_not_found') {
    return `Instagram search reported no usable match for @${u}. ${diag}`;
  }
  if (pick.reason === 'account_private') {
    return `Page suggests private/restricted while on search. ${diag}`;
  }
  if (pick.reason === 'rate_limited') {
    return `Page suggests rate limit while on search. ${diag}`;
  }
  return `Could not click a search result row for @${u} (automation). ${diag}`;
}

module.exports = { clickInstagramDmSearchResult, formatSearchFailurePageSnippet };
