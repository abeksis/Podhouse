'use strict';

// What a backup must NOT contain.
//
// Both of these were found on a real box: state/restore held 4.4GB of an
// uploaded archive waiting to be applied, and every platform update and every
// config backup was compressing it again. The excludes are the fix, and they
// are the kind that stop being true silently — nothing fails, the archive just
// grows by gigabytes — so they are asserted here rather than trusted.

const assert = require('node:assert/strict');
const test = require('node:test');

const backup = require('../lib/backup');

/** True when tar would skip this path, in either of the two spellings tar needs. */
function excluded(args, target) {
  return args.includes(`--exclude=${target}`) || args.includes(`--exclude=./${target}`);
}

test('a config backup leaves out the restore staging directory', () => {
  const args = backup.tarArgs('config');
  assert.ok(excluded(args, 'state/restore'),
    'state/restore holds an uploaded archive; backing it up is a backup of a backup');
});

test('a full backup leaves it out too', () => {
  const args = backup.tarArgs('full');
  assert.ok(excluded(args, 'state/restore'));
});

test('the backups directory itself is still left out', () => {
  const args = backup.tarArgs('config');
  assert.ok(excluded(args, 'backups'));
});

test('the quiesce marker is still left out', () => {
  const args = backup.tarArgs('config');
  assert.ok(excluded(args, 'state/backup-quiesce.json'));
});

test('module-declared excludes are still passed through', () => {
  const args = backup.tarArgs('config', ['modules/radarr/config/radarr/logs']);
  assert.ok(args.includes('--exclude=modules/radarr/config/radarr/logs'));
});

test('state and .env are what is actually archived', () => {
  const args = backup.tarArgs('config');
  assert.ok(args.includes('state'), 'state carries the box configuration');
  assert.ok(!args.includes('data'), 'a config backup does not carry the media pool');
});
