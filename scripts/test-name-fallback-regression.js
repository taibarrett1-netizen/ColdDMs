#!/usr/bin/env node
const assert = require('assert');
const { substituteVariables } = require('../utils/message-variables');

function run() {
  const template = 'Hey {{first_name}}!';
  const withDisplayName = substituteVariables(template, {
    username: 'momsmindbusiness',
    display_name: 'Sarah Johnson',
    first_name: null,
    last_name: null,
  });
  assert.strictEqual(withDisplayName, 'Hey Sarah!', 'display_name should supply first_name when first_name is null');

  const symbolOnlyFirstWord = substituteVariables(template, {
    username: 'emoji_name',
    display_name: '✨ Sarah',
    first_name: null,
    last_name: null,
  });
  assert.strictEqual(
    symbolOnlyFirstWord,
    'Hey!',
    'symbol-only first token should not produce broken greeting with dangling space'
  );

  const fromFirstNameFallback = substituteVariables(template, {
    username: 'ugcbysarah.s',
    display_name: null,
    first_name: 'sarah',
    last_name: null,
  });
  assert.strictEqual(fromFirstNameFallback, 'Hey Sarah!', 'first_name fallback should still work');

  console.log('name fallback regression tests passed');
}

run();
