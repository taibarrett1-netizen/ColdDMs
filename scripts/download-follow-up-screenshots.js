#!/usr/bin/env node
/**
 * Download all follow-up debug PNGs from the dashboard API.
 *
 * Usage:
 *   BASE=http://178.62.52.200:3000 KEY=your_cold_dm_api_key node scripts/download-follow-up-screenshots.js
 *
 * Or:
 *   node scripts/download-follow-up-screenshots.js http://178.62.52.200:3000 your_cold_dm_api_key
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const BASE = (process.env.BASE || process.argv[2] || 'http://127.0.0.1:3000').replace(/\/$/, '');
const KEY = process.env.KEY || process.argv[3];

function fetchBuffer(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(
      url,
      { headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks),
          })
        );
      }
    );
    req.on('error', reject);
  });
}

async function main() {
  if (!KEY) {
    console.error('Missing KEY.\n');
    console.error('  BASE=http://IP:3000 KEY=b12c9af6cda400a483c7d03a99e9f771c4eed254501ceb202bd65b8589f43354 scripts/download-follow-up-screenshots.js');
    console.error('  node scripts/download-follow-up-screenshots.js http://IP:3000 your_secret\n');
    process.exit(1);
  }

  const listUrl = `${BASE}/api/debug/follow-up-screenshots`;
  console.log('Listing:', listUrl);

  const { status, body } = await fetchBuffer(listUrl, {
    Authorization: `Bearer ${KEY}`,
  });

  const text = body.toString('utf8');
  console.log('HTTP', status);
  if (status === 401) {
    console.error('Unauthorized — KEY must match COLD_DM_API_KEY on the server (one line, no extra spaces/newlines).');
    process.exit(1);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    console.error('Response was not JSON:', text.slice(0, 400));
    process.exit(1);
  }

  if (data.error) {
    console.error('API error:', data.error);
    process.exit(1);
  }

  const files = data.files || [];
  console.log('files count:', files.length);
  if (!files.length) {
    console.log('\nNo PNGs on the server. Run a voice follow-up with FOLLOW_UP_DEBUG_SCREENSHOTS=true, or on VPS:');
    console.log('  ls -la /path/to/app/follow-up-screenshots');
    process.exit(0);
  }

  const outDir = path.join(process.cwd(), 'follow-up-screenshots-download');
  fs.mkdirSync(outDir, { recursive: true });
  console.log('Saving to:', outDir, '\n');

  for (const f of files) {
    const name = f.name;
    const fileUrl = `${BASE}/api/debug/follow-up-screenshots/file?${new URLSearchParams({ name })}`;
    const { status: st, body: buf } = await fetchBuffer(fileUrl, {
      Authorization: `Bearer ${KEY}`,
    });
    if (st !== 200) {
      console.error('FAIL', name, 'HTTP', st, buf.toString('utf8').slice(0, 200));
      continue;
    }
    const dest = path.join(outDir, name);
    fs.writeFileSync(dest, buf);
    console.log('OK', name, buf.length, 'bytes');
  }

  console.log('\nDone.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
