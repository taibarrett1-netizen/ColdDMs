#!/usr/bin/env node
/**
 * Download follow-up debug PNGs from a remote dashboard (same machine as PM2 or tunneled).
 *
 *   BASE=http://178.62.52.200:3000 KEY=your_cold_dm_api_key node scripts/download-follow-up-screenshots.js
 *   node scripts/download-follow-up-screenshots.js http://178.62.52.200:3000 your_cold_dm_api_key
 *
 * Saves to ./follow-up-screenshots-download/ (created if missing).
 */
const fs = require('fs');
const path = require('path');

const outDir = path.join(process.cwd(), 'follow-up-screenshots-download');

function usage() {
  console.error('Usage:');
  console.error('  BASE=http://host:3000 KEY=your_cold_dm_api_key node scripts/download-follow-up-screenshots.js');
  console.error('  node scripts/download-follow-up-screenshots.js http://host:3000 your_cold_dm_api_key');
  process.exit(1);
}

async function main() {
  let base = (process.env.BASE || '').trim().replace(/\/$/, '');
  let key = (process.env.KEY || '').trim();
  if (!base && process.argv[2]) base = String(process.argv[2]).replace(/\/$/, '');
  if (!key && process.argv[3]) key = String(process.argv[3]);

  if (!base) usage();

  const listUrl = `${base}/api/debug/follow-up-screenshots`;
  const headers = key ? { Authorization: `Bearer ${key}` } : {};

  const listRes = await fetch(listUrl, { headers });
  if (!listRes.ok) {
    const t = await listRes.text();
    console.error(`List failed: ${listRes.status} ${listRes.statusText}`);
    console.error(t.slice(0, 500));
    process.exit(1);
  }

  const data = await listRes.json();
  if (!data.ok || !Array.isArray(data.files)) {
    console.error('Unexpected response:', JSON.stringify(data).slice(0, 400));
    process.exit(1);
  }

  if (data.files.length === 0) {
    console.log('No PNGs on the server. Run a voice follow-up with FOLLOW_UP_DEBUG_SCREENSHOTS=true, or on VPS:');
    console.log(`  ls -la ${data.directory || 'follow-up-screenshots'}`);
    process.exit(0);
  }

  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  let ok = 0;
  for (const f of data.files) {
    const name = f.name;
    const fileUrl = `${base}/api/debug/follow-up-screenshots/file?${new URLSearchParams({ name })}`;
    const fileRes = await fetch(fileUrl, { headers });
    if (!fileRes.ok) {
      console.warn(`Skip ${name}: ${fileRes.status}`);
      continue;
    }
    const buf = Buffer.from(await fileRes.arrayBuffer());
    const dest = path.join(outDir, name);
    fs.writeFileSync(dest, buf);
    console.log(`Saved ${dest}`);
    ok += 1;
  }
  console.log(`Done. ${ok}/${data.files.length} file(s) → ${outDir}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
