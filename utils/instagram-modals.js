/**
 * Dismiss blocking Instagram Web modals (home feed, DM composer overlays).
 */
function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * After landing on instagram.com — dismiss "Turn on Notifications" and similar.
 * Without this, the feed is blocked and later navigation can behave oddly.
 */
async function dismissInstagramHomeModals(page, logger) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const clicked = await page.evaluate(() => {
      const dialogs = document.querySelectorAll('[role="dialog"], [role="alertdialog"]');
      for (let d = 0; d < dialogs.length; d++) {
        const root = dialogs[d];
        const txt = (root.textContent || '').toLowerCase();
        const relevant =
          txt.includes('turn on notifications') ||
          txt.includes('save your login') ||
          (txt.includes('notification') && txt.includes('know right away'));
        if (!relevant) continue;
        const clickables = Array.from(root.querySelectorAll('button, div[role="button"], span[role="button"], span'));
        const notNow = clickables.find((el) => {
          if (!el.offsetParent) return false;
          const t = (el.textContent || '').trim().toLowerCase();
          return t === 'not now';
        });
        if (notNow) {
          const btn = notNow.closest('[role="button"]') || notNow.closest('button') || notNow;
          btn.click();
          return 'not_now';
        }
      }
      return false;
    });
    if (clicked) {
      if (logger) logger.log('Dismissed Instagram home modal (notifications or similar)');
      await delay(800);
      continue;
    }
    break;
  }
}

/** Close sticker picker / GIF / emoji popovers that steal clicks from the mic. */
async function closeDmComposerOverlays(page) {
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('Escape');
    await delay(180);
  }
}

module.exports = {
  dismissInstagramHomeModals,
  closeDmComposerOverlays,
  delay,
};
