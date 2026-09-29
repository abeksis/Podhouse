'use strict';

// The forecast's place and words, without the network.

const test = require('node:test');
const assert = require('node:assert');
const weather = require('../lib/weather');

test('the city comes from the timezone, and UTC has none', () => {
  assert.strictEqual(weather.placeFromZone('Asia/Jerusalem'), 'Jerusalem');
  assert.strictEqual(weather.placeFromZone('America/New_York'), 'New York');
  assert.strictEqual(weather.placeFromZone('UTC'), null);
  assert.strictEqual(weather.placeFromZone(''), null);
});

test('weather codes become a word and a symbol', () => {
  assert.strictEqual(weather.describe(0).label, 'Clear');
  assert.strictEqual(weather.describe(63).label, 'Rain');
  assert.strictEqual(weather.describe(95).label, 'Thunderstorm');
  assert.strictEqual(weather.describe(1234).label, 'Unknown');
});

test('HB_WEATHER=off means nothing is fetched', async () => {
  const before = process.env.HB_WEATHER;
  process.env.HB_WEATHER = 'off';
  try {
    assert.deepStrictEqual(await weather.forecast({ place: 'Haifa' }), { enabled: false });
  } finally {
    if (before === undefined) delete process.env.HB_WEATHER; else process.env.HB_WEATHER = before;
  }
});
