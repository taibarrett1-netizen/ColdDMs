#!/usr/bin/env node
const assert = require('assert');

function claimCampaignFromRows(rows, workerId) {
  for (const row of rows) {
    const leasedBy = row.send_leased_by_worker || null;
    const leaseUntil = row.send_leased_until ? Date.parse(row.send_leased_until) : NaN;
    const leaseActive = Number.isFinite(leaseUntil) && leaseUntil > Date.now();
    if (leasedBy && leaseActive && leasedBy !== workerId) continue;
    return { ...row, send_leased_by_worker: workerId };
  }
  return null;
}

function run() {
  const activeLeaseRows = [
    {
      id: 'campaign-1',
      send_leased_by_worker: 'worker-a',
      send_leased_until: new Date(Date.now() + 60_000).toISOString(),
    },
  ];
  const blocked = claimCampaignFromRows(activeLeaseRows, 'worker-b');
  assert.strictEqual(blocked, null, 'different worker must not claim campaign with active lease');

  const staleLeaseRows = [
    {
      id: 'campaign-1',
      send_leased_by_worker: 'worker-a',
      send_leased_until: new Date(Date.now() - 60_000).toISOString(),
    },
  ];
  const reclaimed = claimCampaignFromRows(staleLeaseRows, 'worker-b');
  assert.ok(reclaimed, 'stale lease should be reclaimable');
  assert.strictEqual(reclaimed.send_leased_by_worker, 'worker-b');

  const sameWorkerRows = [
    {
      id: 'campaign-1',
      send_leased_by_worker: 'worker-a',
      send_leased_until: new Date(Date.now() + 60_000).toISOString(),
    },
  ];
  const sameWorker = claimCampaignFromRows(sameWorkerRows, 'worker-a');
  assert.ok(sameWorker, 'same worker should be able to renew own campaign lease');

  console.log('campaign send lease behavior tests passed');
}

run();
