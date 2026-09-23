'use strict';
/**
 * Where a tag listing starts. See versions.listFrom.
 *
 * Written after the listing stopped at 2,400 tags and no newer version of any
 * large linuxserver image was ever offered — Sonarr a week behind while
 * telling its own user an update was out. The fix reads from a starting point
 * instead of from the top, and a wrong starting point is the same bug again,
 * silently: the newer tag is simply never read.
 */

const test = require('node:test');
const assert = require('node:assert');
const { listFrom } = require('../lib/versions');

const hub = (tag) => ({ registry: 'registry-1.docker.io', repo: 'library/x', tag });

test('ghcr and lscr resume after the tag the box runs', () => {
  // Push order there, and the cursor must be a tag that exists.
  const tag = '4.0.19.2979-ls323';
  assert.strictEqual(listFrom({ registry: 'lscr.io', repo: 'linuxserver/sonarr', tag }), tag);
  assert.strictEqual(listFrom({ registry: 'ghcr.io', repo: 'a/b', tag }), tag);
});

test('Docker Hub starts at the first number, not at the whole tag', () => {
  // Lexical order there. Starting at the whole tag would skip 4.0.10, which
  // sorts before 4.0.9.
  assert.strictEqual(listFrom(hub('4.0.9')), '4');
  assert.strictEqual(listFrom(hub('17-alpine')), '17');
  assert.strictEqual(listFrom(hub('v1.6.0-ls362')), 'v1');
  assert.ok('4.0.10' > listFrom(hub('4.0.9')), 'the newer tag must sort after the starting point');
});

test('a first number of all nines reads everything', () => {
  // 9 -> 10 sorts backwards, so no starting point is safe.
  assert.strictEqual(listFrom(hub('9.6.1')), null);
  assert.strictEqual(listFrom(hub('99.0')), null);
});

test('an unknown registry reads everything', () => {
  assert.strictEqual(listFrom({ registry: 'quay.io', repo: 'a/b', tag: '1.2.3' }), null);
  assert.strictEqual(listFrom(null), null);
});
