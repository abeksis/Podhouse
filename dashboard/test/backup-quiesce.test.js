'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const backupPath = require.resolve('../lib/backup');
const composePath = require.resolve('../lib/compose');
const statePath = require.resolve('../lib/state-store');

test('interrupted backup recovery retains modules that still fail to start', async () => {
  let marker = { stopped: ['media', 'photos'], at: 1 };
  const starts = [];
  const failures = new Set(['photos']);
  const logs = [];

  const oldState = require.cache[statePath];
  const oldCompose = require.cache[composePath];
  const oldBackup = require.cache[backupPath];
  require.cache[statePath] = {
    id: statePath,
    filename: statePath,
    loaded: true,
    exports: {
      ROOT: process.cwd(),
      readJson: async () => marker,
      writeJson: async (_name, value) => { marker = value; },
    },
  };
  require.cache[composePath] = {
    id: composePath,
    filename: composePath,
    loaded: true,
    exports: {
      start: async (id) => {
        starts.push(id);
        if (failures.has(id)) throw new Error('still unavailable');
      },
    },
  };
  delete require.cache[backupPath];

  try {
    const backup = require(backupPath);
    const first = await backup.resumeAfterQuiesce((line) => logs.push(line));
    assert.deepEqual(first, ['media']);
    assert.deepEqual(marker.stopped, ['photos']);
    assert.match(logs.join('\n'), /will retry photos/);

    failures.clear();
    const second = await backup.resumeAfterQuiesce((line) => logs.push(line));
    assert.deepEqual(second, ['photos']);
    assert.deepEqual(marker, { stopped: [] });
    assert.deepEqual(starts, ['media', 'photos', 'photos']);
  } finally {
    delete require.cache[backupPath];
    if (oldBackup) require.cache[backupPath] = oldBackup;
    if (oldState) require.cache[statePath] = oldState;
    else delete require.cache[statePath];
    if (oldCompose) require.cache[composePath] = oldCompose;
    else delete require.cache[composePath];
  }
});

test('backup archives exclude the live quiesce recovery marker', () => {
  delete require.cache[backupPath];
  const backup = require(backupPath);
  const args = backup.tarArgs('config');
  assert.ok(args.includes('--exclude=./state/backup-quiesce.json'));
  assert.ok(args.includes('--exclude=state/backup-quiesce.json'));
});
