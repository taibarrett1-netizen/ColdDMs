/**
 * Parse http(s)://user:pass@host:port for Puppeteer --proxy-server + page.authenticate.
 * Shared with admin lab sender pattern.
 */
function parseProxyUrl(proxyUrl) {
  if (!proxyUrl || typeof proxyUrl !== 'string') return null;
  const trimmed = proxyUrl.trim();
  if (!trimmed) return null;
  let u;
  try {
    u = new URL(trimmed);
  } catch {
    return null;
  }
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  const server = `http://${u.hostname}:${port}`;
  const username = u.username ? decodeURIComponent(u.username) : null;
  const password = u.password ? decodeURIComponent(u.password) : null;
  return { server, username, password, raw: trimmed };
}

/**
 * Mutates launchOpts.args to add --proxy-server when proxyUrl is set.
 * @param {object} launchOpts - puppeteer launch options with .args array
 * @param {string|null|undefined} proxyUrl
 */
function applyProxyToLaunchOptions(launchOpts, proxyUrl) {
  if (!launchOpts || !Array.isArray(launchOpts.args)) return launchOpts;
  const parsed = parseProxyUrl(proxyUrl);
  launchOpts.args = launchOpts.args.filter((a) => typeof a === 'string' && !a.startsWith('--proxy-server='));
  if (parsed) {
    launchOpts.args.push(`--proxy-server=${parsed.server}`);
  }
  return launchOpts;
}

/**
 * After browser.newPage(), call when proxy has auth.
 */
async function authenticatePageForProxy(page, proxyUrl) {
  const parsed = parseProxyUrl(proxyUrl);
  if (!parsed || !parsed.username) return;
  await page.authenticate({ username: parsed.username, password: parsed.password || '' });
}

module.exports = {
  parseProxyUrl,
  applyProxyToLaunchOptions,
  authenticatePageForProxy,
};
