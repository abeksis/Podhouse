#!/usr/bin/env node
'use strict';
/**
 * Describe each app in its own project's words.
 *
 * For every module mapped to a GitHub project in scripts/upstream.json, this
 * takes from that project:
 *
 *   tagline      the repository's one-line "About"
 *   description  the opening paragraph of its README
 *   source       the repository URL
 *   docs         the project's homepage, when it has one
 *   license      the SPDX id GitHub reports
 *
 * and writes them into the module's x-homebox block, as was done by hand for
 * Beszel. `tips` are never touched: they say what Podhouse does differently,
 * which only this project knows.
 *
 * Run it on a development machine before a release, never on a box: the boxes
 * work offline and ship the result.
 *
 *   node scripts/upstream-meta.js fetch          fill the cache (resumable)
 *   node scripts/upstream-meta.js review [file]  current vs proposed, as HTML
 *   node scripts/upstream-meta.js apply [ids]    write the module files
 *
 * `fetch` caches in scripts/.upstream-cache.json, because GitHub allows 60
 * unauthenticated API calls an hour and there are more modules than that; a
 * run that hits the limit stops and the next run continues where it left off.
 * GITHUB_TOKEN, if set, raises the limit.
 *
 * `apply` skips a module whose file already has `source:`, since that one was
 * written by hand (Beszel's description is longer than its README's first
 * paragraph, on purpose). --force overrides that.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MAP_FILE = path.join(__dirname, 'upstream.json');
const CACHE_FILE = path.join(__dirname, '.upstream-cache.json');
const MODULES = path.join(ROOT, 'modules');

const MAX_DESCRIPTION = 520;

/* ------------------------------------------------------------- fetching */

function headers(extra = {}) {
  const h = { 'User-Agent': 'podhouse-upstream-meta', ...extra };
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

class RateLimited extends Error {}

async function repoInfo(repo) {
  const res = await fetch(`https://api.github.com/repos/${repo}`, { headers: headers({ Accept: 'application/vnd.github+json' }) });
  if (res.status === 403 || res.status === 429) {
    const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
    throw new RateLimited(reset ? new Date(reset).toLocaleTimeString() : 'later');
  }
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${repo}`);
  const r = await res.json();
  return {
    // A renamed repository answers with its new name; keep the real one.
    repo: r.full_name,
    about: r.description || '',
    homepage: r.homepage || '',
    license: r.license && r.license.spdx_id && r.license.spdx_id !== 'NOASSERTION' ? r.license.spdx_id : null,
    branch: r.default_branch,
  };
}

/** The README as text, from raw.githubusercontent — not counted against the API limit. */
async function readme(repo, branch) {
  for (const name of ['README.md', 'readme.md', 'Readme.md', 'README.MD', 'README.markdown', 'README.rst', 'README']) {
    const res = await fetch(`https://raw.githubusercontent.com/${repo}/${branch}/${name}`, { headers: headers() });
    if (res.ok) return res.text();
  }
  return '';
}

/* --------------------------------------------------- reading a README */

/**
 * The first real paragraph of prose.
 *
 * A README opens with a logo, a row of badges, a title and often a table of
 * links before it says what the thing is. Those are all dropped, and the first
 * block left that reads like sentences is taken — plus the next one when the
 * first is a single short line, which is how many projects split "X is Y." from
 * what it does.
 */
function openingParagraph(text) {
  const cleaned = text
    .replace(/\r/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/```[\s\S]*?```/g, '\n\n')
    // Setext headings (a line underlined with === or ---) and rst ones.
    .replace(/^[^\n]*\n[=\-~^]{3,}[ \t]*$/gm, '\n')
    .replace(/^[=\-~^]{3,}[ \t]*$/gm, '\n')
    .replace(/<(picture|table|details|svg)[\s\S]*?<\/\1>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');

  const blocks = cleaned.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  const prose = [];
  for (const block of blocks) {
    if (/^(#|=|-{3,}|\||>|\[!|!\[|\* |- |\d+\. |\.\. )/.test(block)) continue;   // headings, rules, tables, quotes, lists, rst
    if (/^\[.*\]\(.*\)\s*$/.test(block)) continue;                                  // a link on its own
    if (/(badge|shields\.io|build status|license: )/i.test(block)) continue;
    const text = describingSentences(flatten(block));
    if (text.length < 40) continue;
    prose.push(text);
    // A second paragraph only when the first is a one-liner ("X is a Y.").
    if (prose.join(' ').length >= 100 || prose.length === 2) break;
  }
  return trim(prose.join(' '));
}

/**
 * The sentences that say what the app IS, without the ones around them that
 * talk about the README, the repository or the website: a demo link, "see the
 * install guide", a note about tags, a row of nav links, a trademark notice.
 * Those are true and useful on GitHub and meaningless on a card.
 */
const NOT_DESCRIPTION = /(https?:\/\/|www\.|\S+\.(com|org|net|dev|io|app)\b|@\w|\bdemo\b|\b(see|read|check|visit|refer to|please)\b|\b(found|available|hosted) (in|on|at|here)\b|\bnote:|this (document|repository|readme)|how to install|to install|google play|trademark|sponsor|we strive|piping to bash|quick ?start|\s[|•]\s|in development|expect some|contribut|pull request|now running)/i;

function describingSentences(text) {
  // "e.g." and "i.e." are not sentence ends.
  // Nor is the dot in a version number ("Emby's 3.5.2"), or in a file name.
  const guarded = text
    .replace(/\b(e\.g|i\.e|etc)\./gi, (m) => m.replace(/\./g, '․'))
    .replace(/(\w)\.(?=\w)/g, '$1․')
    .replace(/(\s)\.(?=\w)/g, '$1․');                 // ".NET", ".env"
  const sentences = guarded.match(/[^.!?]+(?:[.!?]+|$)/g) || [];
  const kept = [];
  for (const s of sentences) {
    const t = s.trim().replace(/․/g, '.');
    if (!t) continue;
    // Stop at the first sentence that is about something else: what follows
    // it is usually more of the same, and a description with a hole in the
    // middle reads worse than a shorter one. A question is the README talking
    // to its reader ("Want to learn more?"), not describing the app.
    if (NOT_DESCRIPTION.test(t) || t.endsWith('?') || !/[a-z]{3,}/i.test(t)) break;
    kept.push(t);
  }
  return kept.join(' ');
}

function flatten(md) {
  return md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')            // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')          // links -> their text
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')         // reference links
    .replace(/[*_`~]{1,3}([^*_`~]+)[*_`~]{1,3}/g, '$1')
    .replace(/:[a-z0-9_+-]+:/g, '')                  // :emoji: codes
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Cut at a sentence end rather than mid-word. */
function trim(text) {
  if (text.length <= MAX_DESCRIPTION) return text;
  const cut = text.slice(0, MAX_DESCRIPTION);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '));
  return end > 120 ? cut.slice(0, end + 1) : `${cut.replace(/\s+\S*$/, '')}…`;
}

/**
 * The repository's About line, when it describes the app. Some are notices
 * instead ("NOW MANAGED ON CODEBERG", "Documentation is here: …"); those give
 * null and the module keeps its own tagline.
 */
function tidyAbout(text) {
  const t = flatten(text).replace(/^[^\p{L}\p{N}#]+/u, '').replace(/[\p{Extended_Pictographic}‍️]+/gu, '').replace(/\s+/g, ' ').trim();
  if (!t || /(https?:\/\/|documentation|now managed|moved to|mirror of|deprecated)/i.test(t) || t === t.toUpperCase()) return null;
  return t;
}

/* ------------------------------------------------------ module files */

function moduleFile(id) {
  return path.join(MODULES, id, 'docker-compose.yml');
}

function currentValues(id) {
  const text = fs.readFileSync(moduleFile(id), 'utf8');
  const get = (key) => {
    const m = new RegExp(`^  ${key}: (.*)$`, 'm').exec(text);
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch { return m[1].replace(/^"|"$/g, ''); }
  };
  return { tagline: get('tagline'), description: get('description'), source: get('source') };
}

/**
 * Edit the x-homebox block line by line, so every comment and every other key
 * in the file stays exactly where it was. Values are written as JSON strings,
 * which YAML reads as double-quoted scalars.
 */
function writeModule(id, meta) {
  const file = moduleFile(id);
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const set = (key, value) => {
    const at = lines.findIndex((l) => l.startsWith(`  ${key}: `));
    if (at !== -1) lines[at] = `  ${key}: ${JSON.stringify(value)}`;
    return at;
  };
  if (meta.tagline) set('tagline', meta.tagline);
  // null means "keep ours": the project's README had nothing that says what it is.
  if (meta.description) set('description', meta.description);

  // source, docs, license go right after description, replacing any there.
  for (const key of ['source', 'docs', 'license']) {
    const at = lines.findIndex((l) => l.startsWith(`  ${key}: `));
    if (at !== -1) lines.splice(at, 1);
  }
  const after = lines.findIndex((l) => l.startsWith('  description: '));
  const extra = [`  source: ${JSON.stringify(meta.source)}`];
  if (meta.docs) extra.push(`  docs: ${JSON.stringify(meta.docs)}`);
  if (meta.license) extra.push(`  license: ${JSON.stringify(meta.license)}`);
  lines.splice(after + 1, 0, ...extra);

  const note = '  # tagline, description, source, docs, license: the project\'s own, via scripts/upstream-meta.js';
  if (!lines.includes(note)) {
    const tag = lines.findIndex((l) => l.startsWith('  tagline: '));
    lines.splice(tag, 0, note);
  }
  fs.writeFileSync(file, lines.join('\n'));
}

/* ------------------------------------------------------------ commands */

/**
 * upstream.json maps a module to "owner/repo", or to an object when the README
 * needs a hand:
 *
 *   { "repo": "…", "sentences": 2 }        the first two sentences found
 *   { "repo": "…", "description": "…" }    exact text, copied from the README
 *   { "repo": "…", "description": null }   keep ours; take the rest from them
 *   { "repo": "…", "tagline": null }       keep our tagline
 *
 * Hand-picked text is still theirs, word for word — only the choice of which
 * sentence is ours, where the README opens with install notes or a demo link.
 */
function loadMap() {
  const raw = JSON.parse(fs.readFileSync(MAP_FILE, 'utf8'));
  delete raw._about;
  const map = {};
  for (const [id, v] of Object.entries(raw)) {
    map[id] = v && typeof v === 'object' ? v : (v ? { repo: v } : null);
  }
  return map;
}

function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { return {}; }
}

async function cmdFetch() {
  const map = loadMap();
  const cache = loadCache();
  for (const [id, entry] of Object.entries(cache)) {
    if (entry.readme !== undefined || !entry.source) continue;
    const repo = entry.source.replace('https://github.com/', '');
    cache[id] = { repoAsked: entry.repoAsked, repo, about: entry.tagline || '', homepage: entry.docs || '', license: entry.license, readme: await readme(repo, 'HEAD'), fetchedAt: entry.fetchedAt };
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  }
  const todo = Object.entries(map).filter(([id, m]) => m && (!cache[id] || cache[id].repoAsked !== m.repo)).map(([id, m]) => [id, m.repo]);
  console.log(`${todo.length} to fetch, ${Object.keys(cache).length} cached`);
  for (const [id, repo] of todo) {
    try {
      const info = await repoInfo(repo);
      const text = await readme(info.repo, info.branch);
      // Raw answers, not the processed text: the reading of a README can then
      // improve without asking GitHub again.
      cache[id] = {
        repoAsked: repo,
        repo: info.repo,
        about: info.about,
        homepage: info.homepage,
        license: info.license,
        readme: text,
        fetchedAt: new Date().toISOString(),
      };
      fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
      console.log(`  ${id.padEnd(16)} ${info.repo}`);
    } catch (err) {
      if (err instanceof RateLimited) {
        console.log(`GitHub's hourly limit reached. Run fetch again after ${err.message}; it continues from here.`);
        return;
      }
      console.log(`  ${id.padEnd(16)} FAILED: ${err.message}`);
    }
  }
  console.log('done');
}

/** What a cached answer becomes in a module file. */
function derive(entry, pick = {}) {
  let description = 'description' in pick ? pick.description : openingParagraph(entry.readme || '');
  if (description && pick.sentences) {
    description = (description.match(/[^.!?]+(?:[.!?]+|$)/g) || []).slice(0, pick.sentences).join('').trim();
  }
  const out = {
    source: `https://github.com/${entry.repo}`,
    tagline: tidyAbout(entry.about || ''),
    description,
    docs: /^https:\/\//.test(entry.homepage || '') ? entry.homepage.replace(/\/+$/, '') : null,
    license: entry.license || null,
  };
  if ('tagline' in pick) out.tagline = pick.tagline;
  return out;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function cmdReview(out) {
  const map = loadMap();
  const cache = loadCache();
  const rows = Object.keys(map).sort().map((id) => {
    const now = currentValues(id);
    const next = cache[id] && map[id] && derive(cache[id], map[id]);
    const status = !map[id] ? 'kept — no single upstream project'
      : !next ? 'not fetched yet'
        : now.source ? 'kept — written by hand' : !next.description ? 'NO PARAGRAPH FOUND' : 'will change';
    return `<tr class="${status.startsWith('will') ? 'chg' : status.startsWith('NO') ? 'bad' : 'keep'}">
      <td><b>${esc(id)}</b><br><small>${esc(status)}</small>${next ? `<br><small><a href="${esc(next.source)}">${esc(next.source.replace('https://github.com/', ''))}</a>${next.license ? ` · ${esc(next.license)}` : ''}${next.docs ? ` · <a href="${esc(next.docs)}">docs</a>` : ''}</small>` : ''}</td>
      <td><div class="now">${esc(now.tagline)}</div>${next && !now.source ? `<div class="next">${esc(next.tagline)}</div>` : ''}</td>
      <td><div class="now">${esc(now.description)}</div>${next && !now.source ? `<div class="next">${esc(next.description)}</div>` : ''}</td>
    </tr>`;
  });
  const html = `<!doctype html><meta charset="utf-8"><title>Upstream descriptions</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#1a1a1a;--mut:#666;--line:#ddd;--now:#b3261e;--next:#1b6e3a}
@media (prefers-color-scheme:dark){:root{--bg:#141416;--fg:#eee;--mut:#9a9a9a;--line:#333;--now:#f2a09a;--next:#8fd6a5}}
body{font:14px/1.5 system-ui,sans-serif;margin:16px;background:var(--bg);color:var(--fg)}
table{border-collapse:collapse;width:100%;table-layout:fixed}td,th{border-bottom:1px solid var(--line);padding:8px;vertical-align:top;text-align:left}
th:nth-child(1){width:18%}th:nth-child(2){width:27%}small{color:var(--mut)}a{color:inherit}
.now{color:var(--mut)}.chg .now{text-decoration:line-through;color:var(--now)}.next{color:var(--next);margin-top:4px}.bad td:first-child small{color:var(--now)}
</style>
<p>Grey: stays. Red, struck through: current text. Green: the project's own, proposed.</p>
<table><tr><th>App</th><th>Tagline</th><th>Description</th></tr>${rows.join('')}</table>`;
  const file = out || path.join(__dirname, 'upstream-review.html');
  fs.writeFileSync(file, html);
  console.log(`wrote ${file}`);
}

function cmdApply(args) {
  const force = args.includes('--force');
  const only = args.filter((a) => !a.startsWith('--')).flatMap((a) => a.split(','));
  const map = loadMap();
  const cache = loadCache();
  for (const id of Object.keys(map).sort()) {
    if (only.length && !only.includes(id)) continue;
    const next = cache[id] && map[id] && derive(cache[id], map[id]);
    if (!map[id] || !next) continue;
    if (!next.description && !('description' in map[id])) { console.log(`  ${id.padEnd(16)} skipped: no paragraph found`); continue; }
    if (currentValues(id).source && !force) { console.log(`  ${id.padEnd(16)} skipped: written by hand`); continue; }
    writeModule(id, next);
    console.log(`  ${id.padEnd(16)} written`);
  }
}

const [cmd, ...rest] = process.argv.slice(2);
({ fetch: cmdFetch, review: () => cmdReview(rest[0]), apply: () => cmdApply(rest) }[cmd]
  || (() => { console.log('usage: upstream-meta.js fetch | review [file] | apply [ids] [--force]'); process.exitCode = 2; }))();
