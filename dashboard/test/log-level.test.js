'use strict';

// The level a log line is drawn with, read from the page's own code.
//
// Bazarr pads its logger name to 32 columns, so in
//   2026-09-23 09:19:25,706 - root                             (7f..) :  ERROR (...)
// the level sits ~70 characters in — past the 64 the reader used to look at,
// and its errors were drawn as ordinary lines. The app's own timestamp is
// dropped before the level is looked for.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
const grab = (start, end) => {
  const s = src.indexOf(start);
  const e = src.indexOf(end, s);
  assert.ok(s >= 0 && e > s, `app.js no longer has ${start}`);
  return src.slice(s, e + end.length);
};
const code = [
  grab('const LOG_LEVEL_TOKEN', ';\n'),
  grab('const LOG_LEVEL_KV', ';\n'),
  grab('const APP_STAMP', ';\n'),
  grab('function logLevel(body) {', '\n}\n'),
].join('\n');
const logLevel = new Function(`${code}\nreturn logLevel;`)();

const pad = (s) => s.padEnd(32);

test('Bazarr: the level past a padded logger name', () => {
  assert.strictEqual(logLevel(`2026-09-23 09:19:25,706 - ${pad('root')} (7f03f3450b30) :  ERROR (signalr_client:226) - BAZARR SignalR client for Radarr connection as been lost.`), 'err');
  assert.strictEqual(logLevel(`2026-09-23 08:50:25,487 - ${pad('root')} (7f0418973b28) :  INFO (main:89) - Interactive jobs queue started`), 'info');
  assert.strictEqual(logLevel(`2026-09-23 08:50:25,487 - ${pad('waitress')} (7f0418973b28) :  WARNING (x:1) - slow`), 'warn');
});

test('the formats that already worked still do', () => {
  assert.strictEqual(logLevel('[Error] DownloadDecisionMaker: Couldn\'t process release'), 'err');
  assert.strictEqual(logLevel('time="2026-09-23T08:50:25Z" level=warning msg="x"'), 'warn');
  assert.strictEqual(logLevel('2026-09-23T08:50:25.123Z DEBUG starting'), 'dbg');
  assert.strictEqual(logLevel('Connection to sonarr ok, nothing wrong here'), 'info');
});
