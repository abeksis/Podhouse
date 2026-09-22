'use strict';
/**
 * Every element the page reaches for must exist somewhere.
 *
 * This test exists because of 0.18.0. Three Settings switches were removed and
 * the line that attached listeners to them was left behind:
 *
 *   ['#live-enabled', '#live-transfers', '#live-queues', '#live-upcoming']
 *     .forEach((sel) => { $(sel).addEventListener('change', saveInsightPrefs); });
 *
 * `$('#live-transfers')` was null, so that threw during startup — before
 * anything had drawn. Not the panel that had changed: every page of the
 * dashboard came up blank, on every box that took the release.
 *
 * Nothing caught it. It is not a syntax error, so `node --check` passes. The
 * other tests read YAML and tar arguments and never open the page. The files
 * were verified as SERVED, which they were — and the page was still dead.
 *
 * The rule here is the cheapest one that would have: an id used as
 * `$('#thing').something` has to be in index.html, or be written by the page's
 * own JavaScript into markup it inserts. Anything else is a reference to an
 * element that does not exist, which is a crash waiting for the line to run.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(PUBLIC, 'js', 'app.js'), 'utf8');

/** Ids the document ships with. */
const inHtml = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

/**
 * Ids the page writes itself.
 *
 * Half of this dashboard is rendered from template literals, so plenty of real
 * elements never appear in index.html — `#platform-go` is built by
 * renderPlatform and wired up in the same breath. Those are found the same way
 * the browser would find them: by looking at the markup the file produces.
 */
const inJs = new Set([...js.matchAll(/\bid="([^"$]+)"/g)].map((m) => m[1]));

/**
 * Hash targets, which look exactly like id selectors and are not.
 *
 * `location.hash = '#home'` and `href="#apps"` name PAGES, and the pages are
 * sections whose ids are `screen-home` and `screen-apps`. Collected from the
 * document rather than hardcoded, so adding a page does not fail this test.
 */
const hashes = new Set([
  ...[...html.matchAll(/\bdata-page="([^"]+)"/g)].map((m) => m[1]),
  ...[...html.matchAll(/\bhref="#([^"]+)"/g)].map((m) => m[1]),
  ...[...js.matchAll(/\bdata-page="([^"$]+)"/g)].map((m) => m[1]),
]);

/** Elements the page builds and names in code: `bar.id = 'pending-bar'`. */
const namedInCode = new Set([...js.matchAll(/\.id\s*=\s*'([A-Za-z][\w-]*)'/g)].map((m) => m[1]));

/** `'#fbbf24'` is a colour, not an element. */
const isColour = (s) => /^[0-9a-fA-F]{3,8}$/.test(s);

/**
 * Every id selector the file mentions.
 *
 * The first version of this test looked for `$('#id').something`, which is the
 * shape that is easy to see and NOT the shape that broke the dashboard. The
 * real line was
 *
 *   ['#live-enabled', '#live-transfers', ...].forEach((sel) => $(sel)...)
 *
 * where the id never touches a `$(` at all. Reintroducing the bug did not fail
 * the test, which is the only reason this second version exists: a check that
 * cannot fail is worse than no check, because it is also reassuring.
 *
 * So every `'#thing'` literal in the file counts, wherever it appears.
 */
const used = [...js.matchAll(/'#([A-Za-z][A-Za-z0-9_-]*)'/g)].map((m) => m[1]);

test('every element app.js names exists in the page', () => {
  const missing = [...new Set(used)].filter(
    (id) => !inHtml.has(id) && !inJs.has(id) && !hashes.has(id)
      && !namedInCode.has(id) && !isColour(id));
  assert.deepStrictEqual(
    missing, [],
    `app.js names ${missing.length} element(s) that no markup creates: ${missing.join(', ')}.
`
    + 'This is how 0.18.0 shipped a blank dashboard — see the comment at the top of this file.',
  );
});

test('the pattern that broke 0.18.0 is one this test can see', () => {
  // A guard on the guard, written against the line that actually shipped
  // rather than a tidier one. The first version of this test passed a sample
  // it had made up, and missed the real thing.
  const sample = "['#live-enabled', '#live-transfers'].forEach((sel) => { $(sel).addEventListener('x', y); });";
  const found = [...sample.matchAll(/'#([A-Za-z][A-Za-z0-9_-]*)'/g)].map((m) => m[1]);
  assert.deepStrictEqual(found, ['live-enabled', 'live-transfers']);
});
