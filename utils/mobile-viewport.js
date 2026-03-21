/**
 * Mobile UA and viewport for Instagram automation.
 * Mimics mobile devices to reduce desktop-bot fingerprinting.
 */
const MOBILE_UAS = [
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36',
];

function getRandomMobileUA() {
  return MOBILE_UAS[Math.floor(Math.random() * MOBILE_UAS.length)];
}

const MOBILE_VIEWPORT = { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

function parseViewportDim(envVal, fallback) {
  const n = parseInt(String(envVal || '').trim(), 10);
  return Number.isFinite(n) && n >= 320 && n <= 4096 ? n : fallback;
}

/** Desktop layout for Instagram Web (DM inbox needs width + enough height for thread + composer). */
function buildDesktopViewport() {
  const width = parseViewportDim(process.env.DESKTOP_VIEWPORT_WIDTH, 1920);
  const height = parseViewportDim(process.env.DESKTOP_VIEWPORT_HEIGHT, 1200);
  return { width, height, isMobile: false, hasTouch: false, deviceScaleFactor: 1 };
}

/** Extra pixels for `--window-size` vs layout viewport (tabs, URL bar, bookmark bar — not part of page). */
function getDesktopWindowPadding() {
  const px = Math.max(0, parseInt(process.env.DESKTOP_WINDOW_PAD_X, 10) || 0);
  const py = Math.max(0, parseInt(process.env.DESKTOP_WINDOW_PAD_Y, 10) || 220);
  return { padX: px, padY: py };
}

const DESKTOP_VIEWPORT = buildDesktopViewport();
const DESKTOP_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

async function applyMobileEmulation(page) {
  await page.setUserAgent(getRandomMobileUA());
  await page.setViewport(MOBILE_VIEWPORT);
}

async function applyDesktopEmulation(page) {
  await page.setUserAgent(DESKTOP_UA);
  await page.setViewport(buildDesktopViewport());
}

module.exports = {
  getRandomMobileUA,
  MOBILE_VIEWPORT,
  DESKTOP_VIEWPORT,
  buildDesktopViewport,
  getDesktopWindowPadding,
  applyMobileEmulation,
  applyDesktopEmulation,
};
