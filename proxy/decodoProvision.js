/**
 * Decodo API: create a sub-user per Cold DM IG connect, build http://user:pass@gate:port URL.
 * Docs: https://github.com/Decodo/Decodo-API — POST /v1/auth (Basic), POST /v1/users/:userId/sub-users (Token).
 */
const crypto = require('crypto');
const https = require('https');

const API_BASE = (process.env.DECODO_API_BASE || 'https://api.decodo.com').replace(/\/$/, '');

let authCache = { token: null, userId: null, expiresAt: 0 };

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
          const err = new Error(
            `Decodo HTTP ${res.statusCode}: ${typeof parsed === 'object' ? JSON.stringify(parsed).slice(0, 400) : data.slice(0, 400)}`
          );
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

async function decodoAuth() {
  const now = Date.now();
  if (authCache.token && authCache.userId && now < authCache.expiresAt - 60_000) {
    return { userId: authCache.userId, token: authCache.token };
  }
  const user = (process.env.DECODO_API_USER || '').trim();
  const pass = (process.env.DECODO_API_PASSWORD || '').trim();
  const apiKey = (process.env.DECODO_API_KEY || '').trim();
  /** Official examples use dashboard "username:password" (often email + account password). API key–only accounts: Basic `key:` (empty password). */
  let basic;
  if (user && pass) {
    basic = Buffer.from(`${user}:${pass}`, 'utf8').toString('base64');
  } else if (apiKey) {
    basic = Buffer.from(`${apiKey}:`, 'utf8').toString('base64');
  } else {
    throw new Error(
      'Decodo auth: set DECODO_API_USER + DECODO_API_PASSWORD (dashboard login / account credentials per Decodo docs), or set DECODO_API_KEY alone'
    );
  }
  // No trailing slash — api.decodo.com returns 404 "Route not found" for /v1/auth/
  const { body } = await httpsJson('POST', `${API_BASE}/v1/auth`, { Authorization: `Basic ${basic}` }, null);
  const token = body && (body.token || body.access_token);
  const userId = body && (body.user_id || body.userId);
  if (!token || !userId) {
    throw new Error('Decodo auth response missing user_id or token');
  }
  authCache = {
    token,
    userId: String(userId),
    expiresAt: now + 50 * 60 * 1000,
  };
  return { userId: authCache.userId, token: authCache.token };
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

function randomSubuserPassword() {
  return crypto.randomBytes(16).toString('base64url').replace(/[^a-zA-Z0-9]/g, '').slice(0, 24);
}

function buildProxyUrlFromCredentials(username, password) {
  const host = (process.env.DECODO_GATE_HOST || 'gate.decodo.com').trim();
  const port = String(process.env.DECODO_GATE_PORT || '10001').trim();
  const u = encodeURIComponent(username);
  const p = encodeURIComponent(password);
  return `http://${u}:${p}@${host}:${port}`;
}

/**
 * Create a new Decodo sub-user and return proxy URL + provider_ref for storage.
 */
async function provisionDecodoSubuserProxy(clientId, instagramUsername) {
  const { userId, token } = await decodoAuth();
  const subUsername = stableSubuserUsername(clientId, instagramUsername);
  const subPassword = randomSubuserPassword();
  const serviceType = (process.env.DECODO_SUBUSER_SERVICE_TYPE || 'residential_proxies').trim();

  await httpsJson(
    'POST',
    `${API_BASE}/v1/users/${encodeURIComponent(userId)}/sub-users`,
    { Authorization: `Token ${token}` },
    {
      username: subUsername,
      password: subPassword,
      service_type: serviceType,
    }
  );

  const proxyUrl = buildProxyUrlFromCredentials(subUsername, subPassword);
  const providerRef = {
    decodo_subuser: subUsername,
    gate_host: process.env.DECODO_GATE_HOST || 'gate.decodo.com',
    gate_port: process.env.DECODO_GATE_PORT || '10001',
    service_type: serviceType,
  };
  return { proxyUrl, providerRef };
}

function isDecodoAutoConfigured() {
  if (process.env.DECODO_DISABLE_AUTO === '1' || process.env.DECODO_DISABLE_AUTO === 'true') return false;
  const user = (process.env.DECODO_API_USER || '').trim();
  const pass = (process.env.DECODO_API_PASSWORD || '').trim();
  const apiKey = (process.env.DECODO_API_KEY || '').trim();
  return (user && pass) || !!apiKey;
}

module.exports = {
  provisionDecodoSubuserProxy,
  isDecodoAutoConfigured,
  stableSubuserUsername,
};
