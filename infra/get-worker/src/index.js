/**
 * get.podhouse.dev — the front door for installing and updating Podhouse.
 *
 *   /install.sh      scripts/bootstrap.sh on main
 *   /uninstall.sh    scripts/uninstall.sh on main
 *   /manifest.json   releases/manifest.json on main (what boxes check for updates)
 *   /stats           counts, for the maintainer (needs STATS_TOKEN)
 *   anything else    → the website
 *
 * It replaces a plain Cloudflare redirect so the project can know two numbers:
 * how many installs start, and how many boxes are running which version. Both
 * are counted without keeping anything that identifies a person or a box:
 *
 * - An install is one increment of a (day, script, country) counter. The script
 *   counters carry one more bit: whether the request came from curl/wget, which
 *   means the script is being RUN, or from a browser, which means somebody is
 *   reading it before running it. After a launch post most of the traffic is
 *   reading, so counting them as one number says nothing. Only that bit is
 *   taken from the user agent; the agent itself is not stored, and neither is
 *   the IP or anything else about the request.
 * - A running box is recognised within ONE day by a hash of its IP, the date
 *   and a secret salt, so its 96 update checks a day count once. The hash
 *   cannot be reversed without the salt, cannot be linked to the same box on
 *   another day (the date is inside it), and the rows holding it are folded
 *   into plain per-version totals and deleted by the daily rollup.
 *
 * Counting is best effort and never in the way: the file is served whether or
 * not the database write works, and GitHub's answer (including 304) is passed
 * straight through.
 */

const REPO = 'abeksis/Podhouse';
const RAW = `https://raw.githubusercontent.com/${REPO}/main`;
const SITE = 'https://podhouse.dev';

const FILES = {
  '/install.sh': { path: 'scripts/bootstrap.sh', kind: 'install', type: 'text/x-shellscript; charset=utf-8' },
  '/uninstall.sh': { path: 'scripts/uninstall.sh', kind: 'uninstall', type: 'text/x-shellscript; charset=utf-8' },
  '/manifest.json': { path: 'releases/manifest.json', kind: 'check', type: 'application/json; charset=utf-8' },
};

// Raw rows older than this are folded into totals and removed.
const KEEP_RAW_DAYS = 2;

const today = () => new Date().toISOString().slice(0, 10);
const VERSION = /^\d+\.\d+\.\d+$/;

// A client that fetches a shell script to run it, as opposed to a browser
// opening the URL to read it. Anything unrecognised counts as reading, so an
// odd agent understates runs rather than inventing them.
const RUNNER = /^(curl|wget|libfetch|httpie|fetch|powershell|go-http-client)/i;

const KINDS = ['install', 'install_read', 'uninstall', 'uninstall_read'];

// The first FULL day of the run/read split. Earlier days hold one number that
// is both — including the deploy day itself, which is mixed — and the page says
// so instead of showing them as zero reads.
const SPLIT_FROM = '2026-09-17';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/stats' || url.pathname === '/stats.json') return stats(request, env, url);

    const file = FILES[url.pathname];
    if (!file) return Response.redirect(SITE, 302);
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('method not allowed', { status: 405 });

    const upstream = await fetch(`${RAW}/${file.path}`, {
      method: request.method,
      headers: pick(request.headers, ['if-none-match', 'if-modified-since']),
      cf: { cacheTtl: 60, cacheEverything: true },
    });

    // Count only real GETs that got the file (or a 304 for it). A HEAD, or a
    // GitHub error, is not an install and not a box.
    if (request.method === 'GET' && (upstream.status === 200 || upstream.status === 304) && env.DB) {
      ctx.waitUntil(count(file.kind, request, env).catch((err) => console.log(`count failed: ${err.message}`)));
      ctx.waitUntil(maybeRollup(env).catch((err) => console.log(`rollup failed: ${err.message}`)));
    }

    const headers = new Headers();
    for (const h of ['etag', 'last-modified', 'content-length']) {
      const v = upstream.headers.get(h);
      if (v) headers.set(h, v);
    }
    headers.set('content-type', file.type);
    headers.set('cache-control', 'no-cache');
    return new Response(upstream.body, { status: upstream.status, headers });
  },

  // Kept for accounts that can use a cron trigger; maybeRollup() covers the rest.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(rollup(env));
  },
};

function pick(headers, names) {
  const out = {};
  for (const n of names) {
    const v = headers.get(n);
    if (v) out[n] = v;
  }
  return out;
}

function country(request) {
  const c = request.cf && request.cf.country;
  return typeof c === 'string' && /^[A-Z]{2}$/.test(c) ? c : 'XX';
}

async function count(kind, request, env) {
  const day = today();
  const cc = country(request);

  if (kind !== 'check') {
    // install / uninstall for a run, install_read / uninstall_read for a read.
    const what = RUNNER.test(request.headers.get('user-agent') || '') ? kind : `${kind}_read`;
    await env.DB.prepare(
      `INSERT INTO events (day, kind, country, n) VALUES (?1, ?2, ?3, 1)
       ON CONFLICT (day, kind, country) DO UPDATE SET n = n + 1`,
    ).bind(day, what, cc).run();
    return;
  }

  // A box says which version it is on; anything that is not plainly a
  // version (a browser, curl by hand) is not counted as a box.
  const version = (request.headers.get('x-homebox-version') || '').trim();
  if (!VERSION.test(version)) return;

  const ip = request.headers.get('cf-connecting-ip') || '';
  const id = await sha256(`${env.SALT || ''}|${day}|${ip}`);
  // INSERT OR IGNORE: a box's later checks the same day write nothing.
  await env.DB.prepare(
    'INSERT OR IGNORE INTO boxes (day, id, version, country) VALUES (?1, ?2, ?3, ?4)',
  ).bind(day, id.slice(0, 32), version, cc).run();
}

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// The rollup is idempotent, so running it once per isolate per day is enough
// and needs no schedule: whichever request arrives first after midnight does it.
let rolledUpDay = null;
function maybeRollup(env) {
  const day = today();
  if (rolledUpDay === day) return Promise.resolve();
  rolledUpDay = day;
  return rollup(env);
}

async function rollup(env) {
  const cutoff = new Date(Date.now() - KEEP_RAW_DAYS * 86400000).toISOString().slice(0, 10);
  // A box that changed version mid-day is counted under the version it first
  // reported that day — one row per box per day, never two.
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO box_days (day, version, country, n)
       SELECT day, version, country, COUNT(*) FROM boxes WHERE day < ?1 GROUP BY day, version, country
       ON CONFLICT (day, version, country) DO UPDATE SET n = excluded.n`,
    ).bind(cutoff),
    env.DB.prepare('DELETE FROM boxes WHERE day < ?1').bind(cutoff),
  ]);
}

/* ----------------------------------------------------------------- stats */

async function stats(request, env, url) {
  const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '') || url.searchParams.get('key') || '';
  if (!env.STATS_TOKEN || !(await sameSecret(token, env.STATS_TOKEN))) {
    return new Response('not found', { status: 404 });
  }

  const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 30, 1), 365);
  const since = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);

  // ?hide=IL,NL leaves those countries out of every number — the way to read
  // the page without your own boxes and your own testing in it. Nothing is
  // hidden unless it is asked for, and the page says what it dropped.
  const hidden = new Set((url.searchParams.get('hide') || '')
    .split(',').map((c) => c.trim().toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c)));

  // Live rows for the last two days, folded totals before that.
  const boxesSql = `
    SELECT day, version, country, n FROM box_days WHERE day >= ?1
    UNION ALL
    SELECT day, version, country, COUNT(*) AS n FROM boxes WHERE day >= ?1 GROUP BY day, version, country`;

  const [events, boxes] = await Promise.all([
    env.DB.prepare('SELECT day, kind, country, n FROM events WHERE day >= ?1 ORDER BY day').bind(since).all(),
    env.DB.prepare(boxesSql).bind(since).all(),
  ]);

  const byDay = {};
  const row = (d) => (byDay[d] ||= {
    day: d, install: 0, install_read: 0, uninstall: 0, uninstall_read: 0, boxes: 0, versions: {},
  });

  // Where the script was fetched from, runs and reads kept apart.
  const scripts = {};
  for (const e of events.results) {
    if (hidden.has(e.country)) continue;
    if (!KINDS.includes(e.kind)) continue;
    row(e.day)[e.kind] += e.n;
    if (e.kind === 'install' || e.kind === 'install_read') {
      const s = (scripts[e.country] ||= { runs: 0, reads: 0 });
      if (e.kind === 'install') s.runs += e.n;
      else s.reads += e.n;
    }
  }

  const liveBoxes = boxes.results.filter((b) => !hidden.has(b.country));
  for (const b of liveBoxes) {
    const r = row(b.day);
    r.boxes += b.n;
    r.versions[b.version] = (r.versions[b.version] || 0) + b.n;
  }

  // Today is a few hours of UTC, so it is never the headline: the cards report
  // the last day that is over, and today is shown next to it as a partial.
  const now = today();
  const daysList = Object.values(byDay).sort((a, b) => a.day.localeCompare(b.day));
  const lastFull = daysList.filter((d) => d.day < now && d.boxes > 0).pop() || null;
  const todayRow = byDay[now] || null;

  const boxCountries = {};
  if (lastFull) {
    for (const b of liveBoxes) {
      if (b.day === lastFull.day) boxCountries[b.country] = (boxCountries[b.country] || 0) + b.n;
    }
  }

  const versions = lastFull ? lastFull.versions : {};
  const top = Object.entries(versions).sort((a, b) => b[1] - a[1])[0] || null;
  const total = (k) => daysList.reduce((s, d) => s + d[k], 0);
  const summary = {
    days,
    since,
    today: now,
    split_from: SPLIT_FROM,
    hidden: [...hidden],
    installs: total('install'),
    install_reads: total('install_read'),
    uninstalls: total('uninstall'),
    uninstall_reads: total('uninstall_read'),
    boxes_last_full_day: lastFull ? lastFull.boxes : 0,
    last_full_day: lastFull ? lastFull.day : null,
    boxes_today: todayRow ? todayRow.boxes : 0,
    versions_last_full_day: versions,
    top_version: top && lastFull
      ? { version: top[0], boxes: top[1], share: Math.round((top[1] / lastFull.boxes) * 100) }
      : null,
    box_countries: boxCountries,
    script_countries: scripts,
    by_day: daysList,
  };

  if (url.pathname === '/stats.json') {
    return new Response(JSON.stringify(summary, null, 2), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
  }
  return new Response(statsHtml(summary), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } });
}

async function sameSecret(a, b) {
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function statsHtml(s) {
  const vlist = (v) => Object.entries(v).sort((a, b) => b[1] - a[1]).map(([n, c]) => `${esc(n)}×${c}`).join(' ') || '—';
  const max = Math.max(1, ...s.by_day.map((d) => Math.max(d.install, d.install_read, d.boxes)));
  const rows = s.by_day.map((d) => {
    const partial = d.day === s.today;
    // Reads only exist from the day the split shipped; before it the one number
    // was both, and saying "0 reads" would be a lie the page can avoid.
    const reads = d.day < s.split_from ? '<span class="q">לא מופרד</span>' : String(d.install_read);
    return `
    <tr class="${partial ? 'now' : ''}"><td>${esc(d.day)}${partial ? ' <span class="q">(היום, חלקי)</span>' : ''}</td>
      <td><span class="bar i" style="width:${(d.install / max) * 100}%"></span>${d.install}</td>
      <td>${reads}</td>
      <td><span class="bar b" style="width:${(d.boxes / max) * 100}%"></span>${d.boxes}</td>
      <td>${d.uninstall}</td>
      <td class="v">${vlist(d.versions)}</td></tr>`;
  }).reverse().join('');

  const countryList = (obj, fmt) => Object.entries(obj)
    .sort((a, b) => fmt.weigh(b[1]) - fmt.weigh(a[1]))
    // dir="ltr" on the value: a number next to a number in an RTL line gets
    // reordered by the browser, and "40 / 3" came out as "3 / 40".
    .map(([k, v]) => `<li><span>${esc(k)}</span><b dir="ltr">${fmt.show(v)}</b></li>`).join('')
    || '<li><span>—</span><b></b></li>';

  const hideLink = s.hidden.length
    ? `<a href="?days=${s.days}">הצג את הכול</a>`
    : `<a href="?days=${s.days}&amp;hide=IL">בלי ישראל</a>`;

  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Podhouse · סטטיסטיקה</title><meta name="robots" content="noindex">
<style>
body{margin:0;background:#12151b;color:#e6e9ef;font:15px/1.55 system-ui,Segoe UI,Arial,sans-serif;padding:28px 18px}
.w{max-width:1000px;margin:auto}h1{margin:0 0 4px;font-size:26px}
.m{color:#8e96a4;margin:0 0 6px;font-size:13.5px}
.m a{color:#f97316}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px;margin:18px 0 22px}
.c{background:#262c36;border:1px solid rgba(203,213,225,.12);border-radius:12px;padding:14px 15px}
.cards .c b{display:block;font-size:30px;line-height:1.2}.cards .c b.s{font-size:22px}
.cards .c span{display:block;color:#bfc5d0;font-size:13.5px;margin-top:2px}
.cards .c small{display:block;color:#8e96a4;font-size:12.5px;margin-top:5px}
.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:10px;margin-bottom:22px}
ul{list-style:none;margin:0;padding:0}
li{display:flex;justify-content:space-between;gap:10px;border-bottom:1px solid rgba(203,213,225,.08);padding:5px 0;font-size:13.5px}
li b{font-weight:600}
h2{font-size:14px;color:#f97316;margin:0 0 8px;font-weight:600}
h2 + p{margin:-4px 0 8px;color:#8e96a4;font-size:12.5px}
.t{overflow-x:auto}table{width:100%;border-collapse:collapse;background:#262c36;border-radius:12px;overflow:hidden}
th,td{padding:7px 10px;border-bottom:1px solid rgba(203,213,225,.08);text-align:start;white-space:nowrap;font-size:13.5px}
th{color:#8e96a4;font-weight:500}
td{position:relative}tr.now td{background:rgba(255,255,255,.03)}
.bar{position:absolute;inset-block:5px;inset-inline-start:0;opacity:.3;border-radius:3px}
.bar.i{background:#f97316}.bar.b{background:#22c55e}
tr.now .bar{opacity:.15}
.q{color:#8e96a4;font-size:12.5px}
.v{color:#8e96a4;direction:ltr;text-align:right}
.note{color:#8e96a4;font-size:12.5px;margin-top:16px}
</style></head><body><div class="w">
<h1>סטטיסטיקת Podhouse</h1>
<p class="m">${s.days} ימים אחרונים, מ-<span dir="ltr">${esc(s.since)}</span>. הכול לפי שעון UTC, ולכן היום הנוכחי תמיד חלקי.</p>
<p class="m">${s.hidden.length ? `לא נספרות: ${esc(s.hidden.join(', '))} · ` : ''}${hideLink}</p>

<div class="cards">
<div class="c"><b>${s.boxes_last_full_day}</b><span>קופסאות שדיווחו</span>
  <small>${s.last_full_day ? `ביום המלא האחרון <span dir="ltr">${esc(s.last_full_day)}</span>` : 'אין עדיין יום מלא'}<br>היום עד כה ${s.boxes_today}</small></div>
<div class="c"><b>${s.installs}</b><span>הרצות של install.sh</span>
  <small>ועוד ${s.install_reads} פתיחות בדפדפן, של אנשים שקראו את הסקריפט</small></div>
<div class="c"><b>${s.uninstalls}</b><span>הרצות של uninstall.sh</span>
  <small>${s.installs ? `${Math.round((s.uninstalls / s.installs) * 100)}% מכמות ההתקנות` : 'אין התקנות בטווח'}</small></div>
<div class="c"><b class="s">${s.top_version ? esc(s.top_version.version) : '—'}</b><span>הגרסה הנפוצה</span>
  <small>${s.top_version ? `${s.top_version.boxes} קופסאות, ${s.top_version.share}% מהן` : 'אף קופסה לא דיווחה'}</small></div>
</div>

<div class="cols">
<div class="c"><h2>איפה רצות קופסאות</h2><p>${s.last_full_day ? `ביום <span dir="ltr">${esc(s.last_full_day)}</span>` : 'אין נתונים'}</p>
  <ul>${countryList(s.box_countries, { weigh: (n) => n, show: (n) => n })}</ul></div>
<div class="c"><h2>מאיפה הורידו את הסקריפט</h2><p>הרצות / קריאות בדפדפן</p>
  <ul>${countryList(s.script_countries, { weigh: (v) => v.runs * 1000 + v.reads, show: (v) => `${v.runs} / ${v.reads}` })}</ul></div>
<div class="c"><h2>גרסאות</h2><p>${s.last_full_day ? `ביום <span dir="ltr">${esc(s.last_full_day)}</span>` : 'אין נתונים'}</p>
  <ul>${Object.entries(s.versions_last_full_day).sort((a, b) => b[1] - a[1]).map(([v, n]) => `<li><span>${esc(v)}</span><b>${n}</b></li>`).join('') || '<li><span>—</span><b></b></li>'}</ul></div>
</div>

<div class="t"><table><thead><tr><th>יום</th><th>הרצות</th><th>קריאות</th><th>קופסאות</th><th>הסרות</th><th>גרסאות</th></tr></thead><tbody>${rows}</tbody></table></div>
<p class="note">ספירה אנונימית: בלי כתובות IP, בלי חשבונות ובלי מעקב בין ימים. "הרצות" הן בקשות של curl או wget, "קריאות" הן פתיחה של הקובץ בדפדפן. קופסה נספרת פעם ביום לפי בדיקת העדכונים שלה.</p>
</div></body></html>`;
}
