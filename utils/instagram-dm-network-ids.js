/**
 * Capture Instagram DM message item_ids from web GraphQL / API responses
 * (observable after send — used for dashboard + webhook dedupe).
 *
 * Instagram shapes change; we deep-scan JSON for item_id / client_item_id and
 * optionally filter to likely send/publish requests to reduce noise from thread sync.
 */

'use strict';

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * @param {unknown} obj
 * @returns {string[]}
 */
function deepCollectItemIds(obj) {
  const out = [];
  const seen = new Set();

  function walk(node, depth) {
    if (depth > 35 || node == null) return;
    const t = typeof node;
    if (t === 'string' || t === 'number' || t === 'boolean') return;
    if (typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const x of node) walk(x, depth + 1);
      return;
    }

    if (node.item_id != null) {
      const s = String(node.item_id).trim();
      if (s && !/^0+$/.test(s)) out.push(s);
    }
    if (node.client_item_id != null) {
      const s = String(node.client_item_id).trim();
      if (s) out.push(s);
    }

    const keys = Object.keys(node);
    for (const k of keys) {
      if (k === 'item_id' || k === 'client_item_id') continue;
      walk(node[k], depth + 1);
    }
  }

  walk(obj, 0);
  return [...new Set(out)];
}

/** Outgoing send / upload — not thread history / inbox sync (those also carry item_ids). */
function looksLikeOutgoingSendPostData(postData) {
  if (!postData || typeof postData !== 'string') return false;
  const p = postData;
  if (/fetch.*thread|inbox.*snapshot|ranked.*recipient|thread.*history|message.*cursor/i.test(p) && !/send|publish|configure/i.test(p)) {
    return false;
  }
  return /send|publish|publisher|mutation|createdirect|direct_send|configure|text_only|voice|audio|rupload|upload/i.test(
    p
  );
}

function isRelevantUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const u = url.toLowerCase();
  return (
    u.includes('graphql/query') ||
    u.includes('graphql_www') ||
    u.includes('/graphql') ||
    u.includes('api/v1/direct') ||
    u.includes('rupload') ||
    u.includes('upload/ig')
  );
}

/**
 * Attach a response listener. Call `waitForOneIdAfter` / `waitForIdsAfter` after each send action.
 *
 * @param {import('puppeteer').Page} page
 * @param {{ logger?: { log?: Function, warn?: Function } }} [options]
 * @returns {{ waitForOneIdAfter: Function, waitForIdsAfter: Function, dispose: Function }}
 */
function attachInstagramSendIdCapture(page, options = {}) {
  const { logger } = options;
  /** @type {{ t: number, ids: string[], url: string }[]} */
  const events = [];

  const handler = async (response) => {
    try {
      const url = response.url();
      if (!isRelevantUrl(url)) return;
      const req = response.request();
      if (req.method() !== 'POST' && req.method() !== 'GET') return;
      const status = response.status();
      if (status < 200 || status >= 300) return;

      const postData = req.postData() || '';
      if (!looksLikeOutgoingSendPostData(postData) && !url.includes('rupload')) {
        return;
      }

      const ctype = (response.headers()['content-type'] || '').toLowerCase();
      if (!ctype.includes('json')) return;

      const text = await response.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        return;
      }

      const ids = deepCollectItemIds(json);
      if (!ids.length) return;

      const t = Date.now();
      events.push({ t, ids, url: url.slice(0, 140) });
      if (logger && process.env.FOLLOW_UP_MESSAGE_ID_DEBUG === '1') {
        logger.log(`[ig-msg-id] +${ids.length} id(s) t=${t} url=${url.slice(0, 100)}`);
      }
    } catch {
      /* ignore */
    }
  };

  page.on('response', handler);

  /**
   * @param {number} sinceMs
   * @param {{ timeoutMs?: number, settleMs?: number }} [opts]
   */
  async function waitForIdsAfter(sinceMs, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? 12000;
    const settleMs = opts.settleMs ?? 500;
    const deadline = Date.now() + timeoutMs;
    let lastLen = 0;
    while (Date.now() < deadline) {
      const slice = events.filter((e) => e.t >= sinceMs);
      const ordered = [];
      for (const e of slice) {
        for (const id of e.ids) {
          if (!ordered.includes(id)) ordered.push(id);
        }
      }
      if (ordered.length > lastLen) {
        lastLen = ordered.length;
        await delay(settleMs);
        const slice2 = events.filter((e) => e.t >= sinceMs);
        const ordered2 = [];
        for (const e of slice2) {
          for (const id of e.ids) {
            if (!ordered2.includes(id)) ordered2.push(id);
          }
        }
        return ordered2;
      }
      await delay(120);
    }
    const slice = events.filter((e) => e.t >= sinceMs);
    const ordered = [];
    for (const e of slice) {
      for (const id of e.ids) {
        if (!ordered.includes(id)) ordered.push(id);
      }
    }
    return ordered;
  }

  /**
   * Prefer the last id in the burst (newest message in batch).
   * @param {number} sinceMs
   * @param {{ timeoutMs?: number }} [opts]
   */
  async function waitForOneIdAfter(sinceMs, opts = {}) {
    const ids = await waitForIdsAfter(sinceMs, opts);
    return ids.length ? ids[ids.length - 1] : null;
  }

  function dispose() {
    page.off('response', handler);
  }

  return { waitForOneIdAfter, waitForIdsAfter, dispose };
}

module.exports = {
  attachInstagramSendIdCapture,
  deepCollectItemIds,
};
