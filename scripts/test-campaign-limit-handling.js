const assert = require('assert');
const { evaluateCampaignLimitState } = require('../bot');

function run() {
  const dailyOnly = evaluateCampaignLimitState({
    sentToday: 40,
    sentThisHour: 30,
    dailySendLimit: 85,
    hourlySendLimit: null,
  });
  assert.strictEqual(dailyOnly.blocked, false, 'daily=85/hourly=null should not be hourly-blocked');

  const unlimited = evaluateCampaignLimitState({
    sentToday: 999,
    sentThisHour: 999,
    dailySendLimit: null,
    hourlySendLimit: null,
  });
  assert.strictEqual(unlimited.blocked, false, 'null/null should be unlimited');

  const hourly10 = evaluateCampaignLimitState({
    sentToday: 9,
    sentThisHour: 10,
    dailySendLimit: null,
    hourlySendLimit: 10,
  });
  assert.strictEqual(hourly10.blocked, true, 'hourly=10 should block at 10/hour');
  assert.strictEqual(hourly10.reason, 'hourly_limit');
  assert.ok(
    hourly10.statusMessage.includes('campaign hourly=10') && hourly10.statusMessage.includes('sentThisHour=10'),
    'hourly message should include source/value details'
  );

  console.log('campaign limit handling tests passed');
}

run();
