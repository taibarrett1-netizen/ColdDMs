/**
 * Dismiss blocking Instagram Web modals — shared by the send worker (bot.js)
 * and the scrape worker (scraper.js).
 *
 * Call dismissInstagramPopups(page, logger) after every page.goto() to handle
 * whatever Instagram decides to throw up that day:
 *   - Cookie consent  ("Allow the use of cookies from Instagram on this browser?")
 *   - Account-switcher / profile "Continue" confirmation
 *   - "Turn on Notifications" / "Save your login" dialogs
 *   - "Review and Agree" / terms / privacy update dialogs
 *   - "See this post in the app" / comment upsell (close only, not Open Instagram)
 *
 * For /accounts/login with saved cookies, call activateInstagramSavedSessionFromLoginPage
 * (used by comment scraper after home load) to tap "Continue as @user" without a password.
 */

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Cookie consent
// ---------------------------------------------------------------------------

/**
 * Dismiss the "Allow the use of cookies from Instagram on this browser?" sheet.
 * Prefers "Allow all cookies"; falls back to "Decline optional cookies" so the
 * page unblocks either way.  Safe to call at any time — returns false quickly
 * if the popup isn't present.
 */
async function dismissInstagramCookieConsent(page) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const clicked = await page.evaluate(() => {
      const roots = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"], div'));
      const targets = roots.filter((el) => {
        const t = (el.textContent || '').toLowerCase();
        return (
          t.includes('allow the use of cookies') ||
          t.includes('allow all cookies') ||
          t.includes('cookie') ||
          t.includes('die verwendung von cookies') ||
          t.includes('cookies durch instagram')
        );
      });
      for (const root of targets) {
        const clickables = Array.from(root.querySelectorAll('button, [role="button"], a, span'));
        const preferred =
          clickables.find((el) =>
            /allow all cookies|allow all|accept all|alle cookies erlauben|cookies erlauben/i.test(
              (el.textContent || '').trim()
            )
          ) ||
          clickables.find((el) =>
            /decline optional cookies|only allow essential|essential cookies|optionale cookies ablehnen|nur erforderliche cookies/i.test(
              (el.textContent || '').trim()
            )
          );
        if (preferred && preferred.offsetParent) {
          const btn = preferred.closest('[role="button"]') || preferred.closest('button') || preferred;
          btn.click();
          return true;
        }
      }
      return false;
    });
    if (!clicked) return false;
    await delay(900);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Account-switcher / profile "Continue" confirmation
// ---------------------------------------------------------------------------

/**
 * Dismiss the account-switcher overlay that Instagram shows on the home page
 * or when landing on a profile — the one with a "Continue" (or "Continue as X")
 * button next to "Log in to another profile" / "Create new account".
 *
 * Uses getBoundingClientRect() for visibility (not offsetParent) because
 * Instagram's account-switcher page uses position:fixed containers where
 * offsetParent is always null even for fully visible elements.
 */
async function dismissInstagramProfileContinue(page) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const clicked = await page.evaluate(() => {
      // offsetParent is null for position:fixed elements — Instagram's account-
      // switcher page uses fixed containers, so use getBoundingClientRect instead.
      function visible(el) {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }

      const bodyText = ((document.body && document.body.innerText) || '').toLowerCase();
      const hasContinueContext =
        bodyText.includes('use another profile') ||
        bodyText.includes('log in to another') ||
        bodyText.includes('create new account') ||
        bodyText.includes('continue as') ||
        bodyText.includes('agree and continue') ||
        bodyText.includes('continue to instagram');

      if (!hasContinueContext) return false;

      const candidates = Array.from(
        document.querySelectorAll('button, [role="button"], div[role="button"], a')
      );
      const hit = candidates.find((el) => {
        if (!visible(el)) return false;
        const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
        return (
          /^continue(\s+as\b.*)?$/i.test(txt) ||
          /^agree and continue$/i.test(txt) ||
          /^continue to instagram$/i.test(txt)
        );
      });

      if (hit) {
        hit.click();
        return true;
      }
      return false;
    });

    if (clicked) {
      // Wait for the navigation that follows the "Continue" click to settle.
      try {
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 8000 });
      } catch (_) {
        // Navigation may not always fire (e.g. SPA route change) — that's fine.
        await delay(1500);
      }
      return true;
    }
    await delay(800);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Notifications / "Save your login" dialogs
// ---------------------------------------------------------------------------

/**
 * After landing on instagram.com — dismiss "Turn on Notifications", "Save your
 * login", and similar home-page blocking modals.
 */
async function dismissInstagramHomeModals(page, logger) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const clicked = await page.evaluate(() => {
      const isNotNow = (el) => /^not now$/i.test((el.textContent || '').replace(/\s+/g, ' ').trim());

      const dialogs = document.querySelectorAll('[role="dialog"], [role="alertdialog"]');
      for (let d = 0; d < dialogs.length; d++) {
        const root = dialogs[d];
        const txt = (root.textContent || '').toLowerCase();
        const relevant =
          txt.includes('turn on notifications') ||
          txt.includes('save your login') ||
          (txt.includes('notification') && txt.includes('know right away'));
        if (!relevant) continue;
        const clickables = Array.from(
          root.querySelectorAll('button, div[role="button"], span[role="button"], span, a')
        );
        const notNow = clickables.find((el) => {
          if (!el.offsetParent) return false;
          return isNotNow(el);
        });
        if (notNow) {
          const btn =
            notNow.closest('[role="button"]') ||
            notNow.closest('button') ||
            notNow.closest('a') ||
            notNow;
          btn.click();
          return 'not_now_dialog';
        }
      }

      // DM thread / mobile: overlay sometimes has no dialog role.
      const bodyLower = ((document.body && document.body.innerText) || '').toLowerCase();
      if (bodyLower.includes('turn on notifications') && bodyLower.includes('not now')) {
        const candidates = Array.from(
          document.querySelectorAll('button, [role="button"], div[role="button"], span, a')
        );
        const hit = candidates.find((el) => el.offsetParent && isNotNow(el));
        if (hit) {
          const btn = hit.closest('button, [role="button"], a') || hit;
          btn.click();
          return 'not_now_global';
        }
      }
      return false;
    });
    if (clicked) {
      if (logger) logger.log('[instagram-modals] Dismissed notification/login modal: ' + clicked);
      await delay(800);
      continue;
    }
    break;
  }
}

// ---------------------------------------------------------------------------
// "Open app" / web upsell (mobile web often blocks comments behind this sheet)
// ---------------------------------------------------------------------------

/**
 * Dismiss "See this post in the app" / "Use the app to view all comments" sheets.
 * Prefers close/dismiss controls — never clicks "Open Instagram" (would leave web).
 */
async function dismissInstagramAppWebUpsell(page, logger) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const action = await page.evaluate(() => {
      const body = ((document.body && document.body.innerText) || '').toLowerCase();
      const upsell =
        body.includes('see this post in the app') ||
        body.includes('use the app to view all comments') ||
        (body.includes('open instagram') &&
          (body.includes('sign up') || body.includes('see this post')));
      if (!upsell) return null;

      function rectVisible(el) {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.width > 4 && r.height > 4;
      }

      const all = Array.from(
        document.querySelectorAll('[aria-label], button, [role="button"], a, div[role="button"]')
      );
      for (let i = 0; i < all.length; i++) {
        const el = all[i];
        if (!rectVisible(el)) continue;
        const al = (el.getAttribute('aria-label') || '').toLowerCase();
        if (
          /\bclose\b/.test(al) ||
          /\bdismiss\b/.test(al) ||
          al === 'back' ||
          al.includes('close') ||
          al.includes('schlie') /* de */
        ) {
          (el.closest('[role="button"]') || el.closest('button') || el).click();
          return 'aria_label_close';
        }
      }

      const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [role="presentation"]'));
      for (let d = 0; d < dialogs.length; d++) {
        const root = dialogs[d];
        const svgs = root.querySelectorAll('svg');
        for (let s = 0; s < svgs.length; s++) {
          const btn = svgs[s].closest('button, [role="button"], a, div[role="button"]');
          if (!btn || !rectVisible(btn)) continue;
          const r = btn.getBoundingClientRect();
          if (r.top < 140 && r.right > window.innerWidth * 0.5) {
            btn.click();
            return 'dialog_corner_svg';
          }
        }
      }

      return 'try_escape';
    });

    if (action === 'try_escape') {
      await page.keyboard.press('Escape').catch(() => {});
      await delay(700);
      continue;
    }
    if (action) {
      if (logger) logger.log('[instagram-modals] Dismissed app/web upsell: ' + action);
      await delay(1100);
      continue;
    }
    break;
  }
}

// ---------------------------------------------------------------------------
// Saved session on /accounts/login (tap profile / "Continue as" — no password)
// ---------------------------------------------------------------------------

/**
 * When cookies exist but IG shows the login chooser, click through to the known
 * pool username without entering a password.
 */
async function activateInstagramSavedSessionFromLoginPage(page, logger, usernameHint) {
  const url = page.url() || '';
  if (!url.includes('instagram.com') || !url.includes('/accounts/login')) return false;

  const hint = String(usernameHint || '')
    .trim()
    .replace(/^@/, '')
    .toLowerCase();
  if (!hint) return false;

  const clicked = await page.evaluate((un) => {
    function rectVisible(el) {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 4 && r.height > 4;
    }

    const candidates = Array.from(
      document.querySelectorAll('a[href], button, [role="button"], div[role="button"]')
    );

    for (let i = 0; i < candidates.length; i++) {
      const el = candidates[i];
      if (!rectVisible(el)) continue;
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      const low = t.toLowerCase();
      if (/create new account|sign up for instagram|sign up with phone/i.test(low)) continue;
      if (/^log in to another profile$/i.test(low) || /^use another profile$/i.test(low)) continue;

      if (/^continue as\b/i.test(t)) {
        if (!un || low.includes(un)) {
          el.click();
          return 'continue_as';
        }
      }
      if (un && low === un && t.length <= 40) {
        el.click();
        return 'username_tile';
      }
    }

    for (let i = 0; i < candidates.length; i++) {
      const el = candidates[i];
      if (el.tagName !== 'A') continue;
      const href = (el.getAttribute('href') || '').toLowerCase();
      if (!href) continue;
      const profilePath = '/' + un + '/';
      const looksLikeProfile =
        href.includes(profilePath) ||
        href.endsWith('/' + un) ||
        href.includes('/' + un + '?');
      if (!looksLikeProfile) continue;
      if (href.includes('/accounts/signup') || href.includes('/accounts/emailsignup')) continue;
      if (rectVisible(el)) {
        el.click();
        return 'profile_href';
      }
    }

    return false;
  }, hint);

  if (clicked && logger) {
    logger.log('[instagram-modals] Activated saved session from login page: ' + clicked + ' (@' + hint + ')');
  }
  if (clicked) {
    try {
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 12000 });
    } catch (_) {
      await delay(2000);
    }
  }
  return Boolean(clicked);
}

// ---------------------------------------------------------------------------
// Review / Terms / Privacy update dialogs
// ---------------------------------------------------------------------------

/**
 * Handle "Review and Agree" / "Updates to our Terms" / "Changes to how we
 * manage data" dialogs.  Clicks Agree / Next / OK to unblock the page.
 */
async function dismissInstagramReviewDialogs(page, logger) {
  for (let i = 0; i < 3; i++) {
    const handled = await page.evaluate(() => {
      const bodyText = (document.body && document.body.innerText) || '';
      if (
        !/review and agree/i.test(bodyText) &&
        !/changes to how we manage data/i.test(bodyText) &&
        !/updates to our terms/i.test(bodyText)
      ) {
        return false;
      }
      const labels = ['Agree to Terms', 'Agree', 'Next', 'OK', 'Accept', 'Continue'];
      const buttons = Array.from(
        document.querySelectorAll('button, div[role="button"], [role="button"]')
      );
      for (const label of labels) {
        const btn = buttons.find(
          (el) => (el.textContent || '').trim().toLowerCase() === label.toLowerCase()
        );
        if (btn && btn.offsetParent) {
          btn.click();
          return true;
        }
      }
      // Fallback: primary blue button inside any dialog.
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
      for (const d of dialogs) {
        const primary = Array.from(
          d.querySelectorAll('button, div[role="button"], [role="button"]')
        ).find((el) => {
          const bg = (window.getComputedStyle(el).backgroundColor || '');
          return /rgb\(0,\s*149,\s*246\)/.test(bg) || /rgb\(0,\s*55,\s*107\)/.test(bg);
        });
        if (primary && primary.offsetParent) {
          primary.click();
          return true;
        }
      }
      return false;
    });
    if (!handled) break;
    if (logger) logger.log('[instagram-modals] Dismissed Review/Terms dialog (' + (i + 1) + ')');
    await delay(1000);
  }
}

// ---------------------------------------------------------------------------
// Composite — call this after every page.goto()
// ---------------------------------------------------------------------------

/**
 * One-stop dismissal for all known Instagram blocking popups.  Safe to call
 * after any navigation — returns quickly if nothing needs dismissing.
 *
 * Order matters: cookies first (can obscure everything else), then
 * account-switcher "Continue", then notifications, then terms.
 */
async function dismissInstagramPopups(page, logger) {
  try {
    const cookieDismissed = await dismissInstagramCookieConsent(page);
    if (cookieDismissed && logger) {
      logger.log('[instagram-modals] Dismissed cookie consent popup');
      // Give the page a moment to re-render after the cookie sheet closes before
      // checking for the account-switcher "Continue" button underneath.
      await delay(1200);
    }
  } catch (e) {
    if (logger) logger.log('[instagram-modals] cookie consent check error: ' + e.message);
  }

  try {
    const continueDismissed = await dismissInstagramProfileContinue(page);
    if (continueDismissed && logger) {
      logger.log('[instagram-modals] Dismissed profile Continue/account-switcher popup');
    }
  } catch (e) {
    if (logger) logger.log('[instagram-modals] profile continue check error: ' + e.message);
  }

  try {
    await dismissInstagramHomeModals(page, logger);
  } catch (e) {
    if (logger) logger.log('[instagram-modals] home modal check error: ' + e.message);
  }

  try {
    await dismissInstagramReviewDialogs(page, logger);
  } catch (e) {
    if (logger) logger.log('[instagram-modals] review dialog check error: ' + e.message);
  }

  try {
    await dismissInstagramAppWebUpsell(page, logger);
  } catch (e) {
    if (logger) logger.log('[instagram-modals] app web upsell check error: ' + e.message);
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
  dismissInstagramCookieConsent,
  dismissInstagramProfileContinue,
  dismissInstagramHomeModals,
  dismissInstagramReviewDialogs,
  dismissInstagramAppWebUpsell,
  activateInstagramSavedSessionFromLoginPage,
  dismissInstagramPopups,
  closeDmComposerOverlays,
  delay,
};
