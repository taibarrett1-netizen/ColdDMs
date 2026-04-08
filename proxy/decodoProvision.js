/**
 * Decodo Public API v2: create sub-users with dashboard API key (Authorization header).
 * OpenAPI: https://help.decodo.com/reference — POST /v2/sub-users (no /v1/auth; that flow was removed).
 */
const crypto = require('crypto');
const https = require('https');

const API_BASE = (process.env.DECODO_API_BASE || 'https://api.decodo.com').replace(/\/$/, '');

function httpsJson(method, path, headers, bodyObj) {
  return new Promise((resolve, reject) => {
    const u = new URL(path.startsWith('http') ? path : `${API_BASE}${path}`);
    const body = bodyObj != null ? JSON.stringify(bodyObj) : null;
    const hdr = {
      Accept: 'application/json',
      ...headers,
    };
    if (body !== null) {
      hdr['Content-Type'] = 'application/json';
      hdr['Content-Length'] = Buffer.byteLength(body);
    } else if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
      hdr['Content-Length'] = '0';
    }
    const opts = {
      method,
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      headers: hdr,
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => {
        data += c;
      });
      res.on('end', () => {
        let parsed = null;
        try {
          parsed = data ? JSON.parse(data) : null;
        } catch {
          parsed = { _raw: data };
        }
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ status: res.statusCode, body: parsed });
        } else {
          const detail =
            parsed && typeof parsed === 'object' ? JSON.stringify(parsed) : String(data || '');
          const err = new Error(`Decodo HTTP ${res.statusCode}: ${detail.slice(0, 2000)}`);
          err.statusCode = res.statusCode;
          err.body = parsed;
          reject(err);
        }
      });
    });
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

/** Trim and strip accidental surrounding quotes from .env / PM2 values */
function normalizeSecret(val) {
  let v = String(val || '').trim();
  if (
    v.length >= 2 &&
    ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
  ) {
    v = v.slice(1, -1).trim();
  }
  return v;
}

/**
 * Decodo OpenAPI uses `apiKey` in header `Authorization` (not necessarily RFC Bearer).
 * Sending `Bearer <key>` often yields 401 "Invalid Api key" — default is **raw key only**.
 *
 * @returns {Record<string, string>}
 */
function getDecodoAuthHeaders() {
  const full = normalizeSecret(process.env.DECODO_AUTHORIZATION);
  if (full) {
    return { Authorization: full };
  }
  const key = normalizeSecret(process.env.DECODO_API_KEY || process.env.DECODO_API_TOKEN);
  if (!key) {
    throw new Error(
      'Decodo: set DECODO_API_KEY (dashboard → API / Public API key). Legacy POST /v1/auth was removed; see https://help.decodo.com/reference/public-api-key-authentication'
    );
  }
  const scheme = (process.env.DECODO_AUTH_SCHEME || 'raw').toLowerCase();
  if (scheme === 'raw') {
    return { Authorization: key };
  }
  if (scheme === 'bearer') {
    if (key.toLowerCase().startsWith('bearer ')) return { Authorization: key };
    return { Authorization: `Bearer ${key}` };
  }
  if (scheme === 'token') {
    return { Authorization: `Token ${key}` };
  }
  return { Authorization: key };
}

function stableSubuserUsername(clientId, instagramUsername) {
  const ig = String(instagramUsername || '')
    .trim()
    .replace(/^@/, '')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .slice(0, 24);
  const h = crypto.createHash('sha256').update(`${clientId}:${ig}`).digest('hex').slice(0, 18);
  return `skm_${h}`;
}

/**
 * Decodo v2: ≥9 chars, ≥1 upper, ≥1 number, no @ or : (docs). Many accounts also enforce a lowercase letter.
 * Use alphanumeric only so proxy URL encoding never breaks.
 */
function randomSubuserPassword() {
  const lower = 'abcdefghijklmnopqrstuvwxyz';
  const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const digits = '0123456789';
  const all = lower + upper + digits;
  const len = 20 + crypto.randomInt(8);
  const chars = [];
  chars.push(upper[crypto.randomInt(upper.length)]);
  chars.push(lower[crypto.randomInt(lower.length)]);
  chars.push(digits[crypto.randomInt(digits.length)]);
  for (let i = chars.length; i < len; i++) {
    chars.push(all[crypto.randomInt(all.length)]);
  }
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  const out = chars.join('').slice(0, 64);
  if (!/[A-Z]/.test(out) || !/[a-z]/.test(out) || !/[0-9]/.test(out) || out.length < 9) {
    return 'Aa9' + out.replace(/[^A-Za-z0-9]/g, 'x').slice(0, 61);
  }
  return out;
}

function buildProxyUrlFromCredentials(username, password) {
  const host = (process.env.DECODO_GATE_HOST || 'gate.decodo.com').trim();
  const port = String(process.env.DECODO_GATE_PORT || '10001').trim();
  const u = encodeURIComponent(username);
  const p = encodeURIComponent(password);
  return `http://${u}:${p}@${host}:${port}`;
}

/** @returns {Promise<Array<{ id?: number, username?: string }>>} */
async function listDecodoSubUsers(authHeaders, serviceType) {
  const q = new URLSearchParams({ service_type: serviceType }).toString();
  const { body } = await httpsJson('GET', `${API_BASE}/v2/sub-users?${q}`, authHeaders, null);
  return Array.isArray(body) ? body : [];
}

async function putDecodoSubUserPassword(authHeaders, subUserId, password) {
  await httpsJson('PUT', `${API_BASE}/v2/sub-users/${encodeURIComponent(subUserId)}`, authHeaders, {
    password,
  });
}

/**
 * Create or reuse a Decodo sub-user (stable username per client+IG) and return proxy URL + provider_ref.
 * If the sub-user already exists (e.g. orphaned from a failed DB write), we rotate password via PUT.
 */
async function provisionDecodoSubuserProxy(clientId, instagramUsername) {
  const authHeaders = getDecodoAuthHeaders();
  const subUsername = stableSubuserUsername(clientId, instagramUsername);
  const subPassword = randomSubuserPassword();
  const serviceType = (process.env.DECODO_SUBUSER_SERVICE_TYPE || 'residential_proxies').trim();

  const enrichError = (e) => {
    if (!e || e.decodoEnriched) return e;
    e.decodoEnriched = true;
    if (e.statusCode === 401) {
      const extra =
        ' Decodo expects the raw key in Authorization by default. If you still see 401, try DECODO_AUTH_SCHEME=bearer, or paste the exact header into DECODO_AUTHORIZATION. Confirm the key is the Proxy Public API key (Settings → API keys), not a scraper-only key.';
      e.message = (e.message || 'Decodo 401') + extra;
    }
    if (e.statusCode === 400) {
      const extra400 =
        ' Read the JSON above: an "error" field often names username/password/service_type. Try DECODO_SUBUSER_SERVICE_TYPE=shared_proxies if you do not have residential. If the sub-user already existed, we retry with PUT; otherwise fix validation or remove the conflicting user in the Decodo dashboard.';
      e.message = (e.message || 'Decodo 400') + extra400;
    }
    return e;
  };

  try {
    let rows = [];
    try {
      rows = await listDecodoSubUsers(authHeaders, serviceType);
    } catch (_) {
      rows = [];
    }
    const existing = rows.find((r) => r && String(r.username) === subUsername);

    if (existing && existing.id != null) {
      await putDecodoSubUserPassword(authHeaders, existing.id, subPassword);
    } else {
      try {
        await httpsJson('POST', `${API_BASE}/v2/sub-users`, authHeaders, {
          username: subUsername,
          password: subPassword,
          service_type: serviceType,
        });
      } catch (postErr) {
        if (postErr && postErr.statusCode === 400) {
          let rows2 = [];
          try {
            rows2 = await listDecodoSubUsers(authHeaders, serviceType);
          } catch (_) {
            rows2 = [];
          }
          const found = rows2.find((r) => r && String(r.username) === subUsername);
          if (found && found.id != null) {
            await putDecodoSubUserPassword(authHeaders, found.id, subPassword);
          } else {
            throw enrichError(postErr);
          }
        } else {
          throw enrichError(postErr);
        }
      }
    }
  } catch (e) {
    throw enrichError(e);
  }

  const proxyUrl = buildProxyUrlFromCredentials(subUsername, subPassword);
  const providerRef = {
    decodo_subuser: subUsername,
    gate_host: process.env.DECODO_GATE_HOST || 'gate.decodo.com',
    gate_port: process.env.DECODO_GATE_PORT || '10001',
    service_type: serviceType,
    api: 'v2',
  };
  return { proxyUrl, providerRef };
}

function isDecodoAutoConfigured() {
  if (process.env.DECODO_DISABLE_AUTO === '1' || process.env.DECODO_DISABLE_AUTO === 'true') return false;
  const key = normalizeSecret(process.env.DECODO_API_KEY || process.env.DECODO_API_TOKEN);
  const auth = normalizeSecret(process.env.DECODO_AUTHORIZATION);
  return !!(key || auth);
}

module.exports = {
  provisionDecodoSubuserProxy,
  isDecodoAutoConfigured,
  stableSubuserUsername,
};
