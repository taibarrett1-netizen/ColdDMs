#!/usr/bin/env node
'use strict';

const puppeteer = require('puppeteer');
const { applyProxyToLaunchOptions, authenticatePageForProxy } = require('../utils/proxy-puppeteer');

async function main() {
  const proxyUrl = String(process.argv[2] || '').trim();
  const targetUrl = String(process.argv[3] || 'https://api.ipify.org?format=json').trim();
  if (!proxyUrl) {
    console.error('Usage: node scripts/test-proxy-connectivity.js <proxyUrl> [targetUrl]');
    process.exit(1);
  }

  const launchOpts = {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--lang=en-US'],
  };
  applyProxyToLaunchOptions(launchOpts, proxyUrl);

  let browser = null;
  try {
    browser = await puppeteer.launch(launchOpts);
    const page = await browser.newPage();
    await authenticatePageForProxy(page, proxyUrl);
    page.setDefaultNavigationTimeout(30000);

    const result = {
      ok: false,
      targetUrl,
      finalUrl: null,
      title: null,
      bodySnippet: null,
      status: null,
    };

    const response = await page.goto(targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    result.status = response ? response.status() : null;
    result.finalUrl = page.url();
    result.title = await page.title().catch(() => null);
    result.bodySnippet = await page
      .evaluate(() => ((document.body && document.body.innerText) || '').slice(0, 300))
      .catch(() => null);
    result.ok = true;

    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          error: err && err.message ? err.message : String(err),
          name: err && err.name ? err.name : null,
          targetUrl,
        },
        null,
        2
      )
    );
    process.exitCode = 2;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

main();
