'use strict';
/**
 * Podhouse dashboard server.
 *
 * No framework and no npm dependencies: the image builds on a box with
 * nothing but a node base image, and there is no dependency tree to audit
 * for a process that holds a Docker socket.
 *
 * This process CAN create and destroy containers, so every route is behind a
 * session — see lib/auth.js. The gate is deny-by-default: PUBLIC_PATHS lists
 * the handful of things the login screen itself needs, and anything not on
 * that list requires a signed-in cookie. A route added tomorrow is protected
 * the moment it exists rather than the moment somebody remembers.
 *
 * It publishes 8443 on the LAN and joins no public network — read
 * docs/SECURITY.md before changing either.
 */

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const docker = require('./lib/docker');
const composeLib = require('./lib/compose');
const worker = require('./lib/worker-client');
const modulesLib = require('./lib/modules');
const hostMetrics = require('./lib/host-metrics');
const activity = require('./lib/activity');
const backup = require('./lib/backup');
const config = require('./lib/config');
const catalog = require('./lib/catalog');
const icons = require('./lib/icons');
const bookmarks = require('./lib/bookmarks');
const auth = require('./lib/auth');
const updates = require('./lib/updates');
const platform = require('./lib/platform');
const insights = require('./lib/insights');
const storage = require('./lib/storage');
const reset = require('./lib/reset');
const restore = require('./lib/restore');
const stats = require('./lib/stats');
const state = require('./lib/state-store');

const PORT = Number(process.env.PORT || 8443);
const PUBLIC_DIR = path.join(__dirname, 'public');
const HOST_ADDRESS = process.env.HB_HOST_ADDRESS || 'localhost';

/**
 * The only paths reachable without a session: the login screen and the files
 * it is built from. Listed explicitly rather than pattern-matched, so nothing
 * becomes public by accident when a new asset is added.
 */
const PUBLIC_PATHS = new Set([
  // Liveness only — no data. The container healthcheck runs before anyone has
  // signed in and must not need a session; pointing it at a real endpoint
  // instead made the dashboard report itself unhealthy the moment auth landed.
  '/healthz',
  '/',
  '/index.html',
  '/css/homebox.css',
  '/js/app.js',
  '/icons/homebox.svg',
  // The background photos, so the sign-in screen can wear the one this
  // browser last showed. Public-domain pictures, nothing about the box.
  '/backgrounds/milky-way.webp',
  '/backgrounds/fog.webp',
  '/backgrounds/aurora.webp',
]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function readVersion() {
  try {
    return fs.readFileSync(path.join(state.ROOT, 'VERSION'), 'utf8').trim();
  } catch {
    return '0.0.0';
  }
}
const VERSION = readVersion();

// Appearance. These lists are the contract with public/css/homebox.css — a
// name here must have a matching [data-theme=...] or [data-accent=...] block.
const THEMES = ['dark', 'midnight', 'dim', 'light'];
const ACCENTS = ['orange', 'blue', 'violet', 'teal', 'green', 'amber', 'rose'];
// Photos behind the page, shipped in public/backgrounds (all CC0; see
// docs/CREDITS.md). 'none' is the plain canvas.
const BACKGROUNDS = ['none', 'milky-way', 'fog', 'aurora'];

// Which parts the "Right now" panel shows. Defaults to on: the panel hides
// itself when it has nothing to say, so a box with no media apps never sees
// it and a box with them gets the numbers without looking for a switch.
const INSIGHT_PANELS = ['transfers', 'queues', 'upcoming'];
/**
 * The parts of the Overview a person can switch off, and the order Customize
 * lists them in. Status is NOT on the list on purpose: a page that can be
 * emptied completely is a page someone can lock themselves out of the answer
 * to "is my server OK", and that answer is what this dashboard is for.
 */
const HOME_SECTIONS = ['welcome', 'apps', 'links', 'pulse'];

const DEFAULT_PREFS = {
  theme: 'dark',
  accent: 'blue',
  background: 'fog',
  insights: { enabled: true, transfers: true, queues: true, upcoming: true },
  // Everything on by default: a box someone has just installed should show
  // what it can do, not the least it can do.
  home: Object.fromEntries(HOME_SECTIONS.map((name) => [name, true])),
};

/**
 * Both values end up in a DOM attribute the stylesheet selects on, so they
 * are whitelisted rather than escaped — an unknown name falls back to the
 * default instead of producing a selector that matches nothing.
 */
function cleanPrefs(input) {
  const p = input && typeof input === 'object' ? input : {};
  const i = p.insights && typeof p.insights === 'object' ? p.insights : {};
  // Whitelisted the same way as the two above, and booleans coerced rather
  // than trusted: these come from an API body, and `"false"` is truthy.
  const insights = { enabled: i.enabled !== false };
  for (const name of INSIGHT_PANELS) insights[name] = i[name] !== false;
  // Same treatment for the Overview's own sections, and the same reason: a
  // name this version does not know is dropped rather than carried through
  // to a page that would act on it.
  const h = p.home && typeof p.home === 'object' ? p.home : {};
  const home = {};
  for (const name of HOME_SECTIONS) home[name] = h[name] !== false;
  // A prefs.json from before 0.4.20 names a light theme ("light-forest") and
  // a background instead of an accent; the light ones keep being light.
  const theme = THEMES.includes(p.theme) ? p.theme
    : (typeof p.theme === 'string' && p.theme.startsWith('light') ? 'light' : DEFAULT_PREFS.theme);
  return {
    theme,
    accent: ACCENTS.includes(p.accent) ? p.accent : DEFAULT_PREFS.accent,
    background: BACKGROUNDS.includes(p.background) ? p.background : DEFAULT_PREFS.background,
    insights,
    home,
  };
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

/**
 * index.html is the one file rendered rather than streamed, so `?v=` on every
 * asset carries the running version.
 *
 * Without it a redeploy leaves the browser on the previous CSS and JS: the
 * files are served `no-cache`, which means "revalidate", and a browser that
 * decides not to bother shows old UI against a new API with nothing on screen
 * to say so. A changing URL removes the judgement call.
 */
/**
 * The cache key: the version, plus when the assets were last built.
 *
 * VERSION alone is not enough — it changes on a release, while the files
 * change on every deploy, and it is the deploys in between that leave a stale
 * page. The assets are baked into the image, so they cannot change under a
 * running process: computing this once at startup is exact.
 */
const ASSET_TAG = (() => {
  let newest = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else newest = Math.max(newest, fs.statSync(full).mtimeMs);
    }
  };
  try {
    for (const sub of ['css', 'js']) walk(path.join(PUBLIC_DIR, sub));
  } catch { /* fall back to the version alone */ }
  return newest ? `${VERSION}-${Math.round(newest / 1000).toString(36)}` : VERSION;
})();

/**
 * Headers every response carries.
 *
 * The page is one document that talks to its own origin and nothing else: no
 * CDN, no fonts, no analytics — which makes a strict policy cheap here where
 * it is usually a fight. `unsafe-inline` for style is the one concession, for
 * the inline widths on the meters and bars.
 *
 * frame-ancestors, not X-Frame-Options: the app is meant to be reachable
 * behind the box's own proxy, and being framed by an unrelated page is how a
 * click lands on "remove" while the person thinks they are clicking something
 * else.
 */
const BASE_HEADERS = {
  'content-security-policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
  ].join('; '),
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'x-frame-options': 'DENY',
};

async function serveIndex(res) {
  const html = (await fsp.readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8'))
    .replace(/__V__/g, encodeURIComponent(ASSET_TAG));
  res.writeHead(200, {
    ...BASE_HEADERS,
    'content-type': MIME['.html'],
    'content-length': Buffer.byteLength(html),
    'cache-control': 'no-cache',
  });
  res.end(html);
}

/**
 * Stream a file to the response, and survive it going wrong mid-flight.
 *
 * A bare `createReadStream(file).pipe(res)` has no error handler: a file that
 * disappears between the stat and the read, or a disk that fails halfway,
 * emits an error on a stream nobody is listening to. The headers are already
 * out by then, so there is nothing left to tell the client — the socket is
 * closed rather than the process.
 */
function streamFile(res, file) {
  const stream = fs.createReadStream(file);
  stream.on('error', (err) => {
    console.error(`[homebox] read failed for ${file}: ${err.message}`);
    res.destroy();
  });
  stream.pipe(res);
}

async function serveStatic(res, urlPath) {
  if (urlPath === '/' || urlPath === '/index.html') return serveIndex(res);

  // Downloaded icons live in state/, outside public/, because public/ is baked
  // into the image and a rebuild would erase them. Names are the hash of the
  // bytes, so a name can only ever mean one file — hence immutable caching.
  if (urlPath.startsWith('/user-icons/')) {
    const file = icons.resolve(decodeURIComponent(urlPath.slice('/user-icons/'.length)));
    if (!file) { res.writeHead(404).end('not found'); return; }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': 'public, max-age=31536000, immutable',
      // These bytes came from a URL somebody pasted. SVG is refused at the
      // download now (lib/icons.js), and this is the second line: the browser
      // may not re-interpret the type, and if one of these ever is opened as a
      // document it runs with nothing — no scripts, no origin, no requests.
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    });
    streamFile(res, file);
    return;
  }
  const rel = urlPath.replace(/^\/+/, '');
  // Resolve, then verify the result is still inside public/: decoded "..",
  // encoded "%2e%2e" and absolute paths all collapse here.
  const target = path.resolve(PUBLIC_DIR, rel);
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const stat = await fsp.stat(target);
    if (stat.isDirectory()) {
      res.writeHead(404).end('not found');
      return;
    }
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-length': stat.size,
      // Icons rarely change; HTML and code must not be cached or a redeploy
      // leaves stale JS talking to a new API.
      'cache-control': ext === '.html' || ext === '.js' || ext === '.css' ? 'no-cache' : 'public, max-age=86400',
    });
    streamFile(res, target);
  } catch {
    res.writeHead(404).end('not found');
  }
}

/** Containers Podhouse runs for itself, which are not apps and are not news. */
const PLATFORM_CONTAINERS = new Set(['homebox-self-update']);

/** Container names are a closed set; never interpolate a client string blind. */
async function resolveContainerName(name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name || '')) return null;
  const containers = await docker.listContainers();
  return containers.some((c) => c.name === name) ? name : null;
}

/**
 * One verdict for the whole box, in the words someone would use out loud.
 * Ordering matters: an unhealthy container is worse news than a stopped one,
 * because a stopped container is usually stopped on purpose.
 */
function healthVerdict(all, metrics, dockerOk) {
  // Podhouse's own machinery is not one of your apps.
  //
  // `homebox-self-update` is deliberately not `--rm`: a failed update has to
  // stay readable afterwards. The cost is that it sits there stopped, and the
  // box then greeted every successful update with "1 container is stopped" —
  // Podhouse reporting its own tooling to you as a fault, every single time.
  //
  // It stays visible in the Logs picker, which is the whole reason it is kept.
  const containers = all.filter((c) => !PLATFORM_CONTAINERS.has(c.name));

  if (!dockerOk) {
    return {
      level: 'bad',
      title: 'Cannot reach Docker',
      sub: 'The socket is not answering, so the state below is empty — not healthy.',
      names: [],
    };
  }
  const running = containers.filter((c) => c.state !== 'stopped');
  const unhealthy = containers.filter((c) => c.state === 'unhealthy');
  const stopped = containers.filter((c) => c.state === 'stopped');
  const starting = containers.filter((c) => c.state === 'starting');

  if (unhealthy.length) {
    return {
      level: 'bad',
      title: unhealthy.length === 1 ? `${unhealthy[0].name} is unhealthy` : `${unhealthy.length} apps are unhealthy`,
      sub: 'Their healthcheck is failing — open the logs to see why.',
      names: unhealthy.map((c) => c.name),
    };
  }
  if (starting.length) {
    return {
      level: 'warn',
      title: `${starting.length} app${starting.length > 1 ? 's are' : ' is'} still starting`,
      sub: 'Give it a moment and this settles by itself.',
      names: starting.map((c) => c.name),
    };
  }
  if (metrics.disk && metrics.disk.percent != null && metrics.disk.percent >= 90) {
    return {
      level: 'warn',
      title: `Disk is ${metrics.disk.percent}% full`,
      sub: 'Apps start failing in ways that look unrelated once the disk fills.',
      names: [],
    };
  }
  if (stopped.length) {
    return {
      level: 'warn',
      title: `${stopped.length} container${stopped.length > 1 ? 's are' : ' is'} stopped`,
      sub: 'Fine if you stopped them on purpose.',
      names: stopped.map((c) => c.name),
    };
  }
  if (running.length === 0) {
    return {
      level: 'warn',
      title: 'Nothing installed yet',
      sub: 'Open Apps and install something — Monitoring and File Browser are good first picks.',
      names: [],
    };
  }
  return {
    level: 'good',
    title: 'Everything is running',
    sub: `${running.length} containers up, nothing needs you right now.`,
    names: [],
  };
}

/**
 * What the Network card shows. Everything here is a fact we can actually
 * check — no placeholder rows that look like features.
 */
function networkInfo(modules, networks) {
  const core = modules.find((m) => m.id === 'core');
  const proxyUp = core && core.installed && core.status !== 'stopped';
  const ours = networks.filter((n) => n.startsWith('homebox'));
  return {
    dashboard: `http://${HOST_ADDRESS}:${PORT}`,
    proxy: proxyUp ? `http://${HOST_ADDRESS} · admin :81` : 'core not running',
    // A real URL for the card's open and copy buttons; the line above is prose.
    proxyAdmin: proxyUp ? `http://${HOST_ADDRESS}:81` : null,
    networks: ours.length ? ours.join(', ') : 'none',
  };
}

/**
 * Backups, for the Overview card: whether archives exist, whether a schedule
 * runs, and whether one can be written at all (no key, no archive), so the
 * card's button is only offered when pressing it can work.
 */
async function backupInfo(modules, metrics) {
  const withConfig = modules.filter((m) => {
    try {
      return fs.existsSync(path.join(m.dir, 'config'));
    } catch {
      return false;
    }
  }).length;
  // Real figures from the Backup Center rather than a stub, so the home card
  // cannot claim nothing is set up while archives sit on disk.
  let center = { count: 0, latest: null, schedule: { enabled: false }, hasKey: false, running: false };
  try {
    center = await backup.status();
  } catch {
    /* backup dir unreadable: the card degrades to "none" rather than erroring */
  }
  return {
    configured: center.count > 0 || center.schedule.enabled,
    scheduled: center.schedule.enabled,
    nextRun: center.schedule.nextRun || null,
    hasKey: !!center.hasKey,
    running: !!center.running,
    count: center.count,
    latest: center.latest,
    // How the last copy went. `ok` stays null until one has been attempted,
    // so a folder set this minute is not reported as broken.
    copy: center.copy && center.copy.configured
      ? {
        configured: true,
        dir: center.copy.dir,
        ok: center.copy.tried ? !center.copy.problem : null,
        problem: center.copy.problem || null,
        count: center.copy.count || 0,
        lastOk: center.copy.lastOk || null,
      }
      : { configured: false },
    appConfigs: withConfig,
    dataDir: path.join(state.ROOT, 'data'),
    diskFree: metrics.disk ? metrics.disk.free : null,
  };
}

/**
 * What is actually waiting for the person reading the page.
 *
 * The Overview used to open with four numbers — uptime, load, memory, disk —
 * which are true and which nobody acts on. This answers the question they
 * came with instead: is anything wrong, and what should I press. Each item is
 * a fact with a verb attached, and an empty list is a real answer.
 *
 * Built here rather than in the browser so the page, the CLI and anything
 * later agree on what "needs you" means, and so a slow check (the image
 * sweep) cannot stall the paint.
 */
async function needsAttention({ metrics, backups, health }) {
  const items = [];
  const [platformState, updateState, dangling] = await Promise.all([
    platform.status().catch(() => null),
    updates.status().catch(() => null),
    docker.danglingImages().catch(() => ({ count: 0, bytes: 0 })),
  ]);

  // An app that fell over outranks anything else here: everything below is
  // housekeeping, and this is the box not doing its job.
  if (health && health.level !== 'good' && health.names && health.names.length) {
    items.push({
      id: 'down', level: 'bad',
      title: health.names.length === 1 ? `${health.names[0]} is not running` : `${health.names.length} apps are not running`,
      detail: health.sub || 'Read its logs to see why it stopped.',
      action: 'logs', target: health.names[0], verb: 'Logs',
    });
  }

  if (platformState && platformState.updateAvailable && platformState.latest) {
    items.push({
      id: 'platform', level: 'warn',
      title: `Podhouse ${platformState.latest} is available`,
      detail: 'Takes about a minute. Your apps keep running, and the box puts the old version back if the new one does not start.',
      action: 'page', target: 'updates', verb: 'Update',
    });
  }

  const appUpdates = updateState && Array.isArray(updateState.newVersions) ? updateState.newVersions : [];
  if (appUpdates.length) {
    const names = [...new Set(appUpdates.map((u) => u.title || u.container))];
    items.push({
      id: 'apps', level: 'warn',
      title: appUpdates.length === 1 ? `${names[0]} has a new version` : `${appUpdates.length} apps have new versions`,
      detail: `${names.slice(0, 3).join(', ')}${names.length > 3 ? ` and ${names.length - 3} more` : ''} — each is backed up first and put back if it does not come up healthy.`,
      action: 'page', target: 'updates', verb: 'Review',
    });
  }

  // Backups: the one thing whose absence costs nothing until the day it costs
  // everything, so it is stated plainly rather than left to a card nobody
  // opens. Ages, not dates: "9 days ago" is the part that matters.
  if (backups) {
    const lastAt = backups.latest && backups.latest.created ? new Date(backups.latest.created).getTime() : null;
    const days = lastAt ? Math.floor((Date.now() - lastAt) / 86400000) : null;
    if (!backups.configured) {
      items.push({
        id: 'backup-none', level: 'warn',
        title: 'No backup has ever been taken',
        detail: 'One archive holds every app\'s settings and the passwords this box generated.',
        action: 'page', target: 'backups', verb: 'Set up',
      });
    } else if (days !== null && days >= 7) {
      items.push({
        id: 'backup-old', level: days >= 30 ? 'bad' : 'warn',
        title: `The last backup was ${days} days ago`,
        detail: backups.scheduled ? 'The schedule is on, so something is failing.' : 'There is no schedule — backups only happen when you ask.',
        action: 'page', target: 'backups', verb: 'Back up',
      });
    }

    // The copy off the box. A failing one is a warning in its own right: the
    // local archives look fine, which is exactly why nobody would notice the
    // NAS stopped taking them.
    const copy = backups.copy || {};
    if (copy.configured && copy.ok === false) {
      items.push({
        id: 'backup-copy', level: 'warn',
        title: 'Backups are not reaching the NAS',
        detail: copy.problem || 'The last copy did not complete.',
        action: 'page', target: 'backups', verb: 'Open',
      });
    }
    // No copy configured at all is NOT listed here. Plenty of people run one
    // box on one disk on purpose, and "Needs you" has no way to be told "I
    // know" — an item that can never go away teaches people to stop reading
    // the panel. The Backups tile and card say it instead, where it is a fact
    // about the backups rather than a demand.
  }

  if (metrics && metrics.disk && metrics.disk.percent != null && metrics.disk.percent >= 85) {
    items.push({
      id: 'disk', level: metrics.disk.percent >= 95 ? 'bad' : 'warn',
      title: `The disk is ${Math.round(metrics.disk.percent)}% full`,
      detail: 'Apps that cannot write stop in ways that look like other problems.',
      action: 'page', target: 'storage', verb: 'Storage',
    });
  }

  // Half a gigabyte is the point where clearing it is worth a click.
  if (dangling.bytes > 512 * 1024 * 1024) {
    items.push({
      id: 'dangling', level: 'info',
      title: `${(dangling.bytes / 1024 ** 3).toFixed(1)}GB of leftover image layers`,
      detail: 'Left behind by rebuilds. Nothing uses them, and clearing them touches no app.',
      action: 'prune', target: null, verb: 'Clear',
    });
  }

  return items;
}

async function apiSummary() {
  const [{ modules, errors }, containers, metrics, dockerVersion, networks] = await Promise.all([
    modulesLib.loadAll(),
    docker.listContainers().catch(() => []),
    hostMetrics.snapshot(),
    docker.version(),
    docker.listNetworks(),
  ]);
  const { modules: withState, unclaimed } = modulesLib.withContainers(modules, containers, HOST_ADDRESS);
  // Both feed the "needs you" list as well as the response, so they are
  // computed once here rather than inline in the object below.
  const health = healthVerdict(containers, metrics, dockerVersion != null);
  const backups = await backupInfo(withState, metrics);
  return {
    // What install.sh wrote, so Settings can show it without reading .env —
    // that file holds every secret and the dashboard has no business in it.
    config: {
      root: state.ROOT,
      modulesDir: modulesLib.MODULES_DIR,
      dataDir: path.join(state.ROOT, 'data'),
      timezone: process.env.TZ || 'UTC',
      port: PORT,
    },
    network: networkInfo(withState, networks),
    backups,
    version: VERSION,
    host: { address: HOST_ADDRESS, name: metrics.hostname },
    docker: dockerVersion,
    metrics,
    health,
    // What is waiting for you, in the order it matters.
    needs: await needsAttention({ metrics, backups, health }),
    counts: {
      // What this box can be offered: an app replaced by others only counts
      // where it still runs.
      modules: withState.filter((m) => !(m.replaced_by.length && !m.installed)).length,
      installed: withState.filter((m) => m.installed).length,
      // Same exclusion as the verdict: a stopped update helper counted here
      // reads as "20 running of 21" on a box where everything is running.
      containers: containers.filter((c) => !PLATFORM_CONTAINERS.has(c.name)).length,
      running: containers.filter((c) => !PLATFORM_CONTAINERS.has(c.name) && c.state !== 'stopped').length,
      unclaimed: unclaimed.length,
    },
    moduleErrors: errors,
    busy: [...inFlight],
  };
}

/**
 * Saving a setting has to TAKE EFFECT, not just be recorded.
 *
 * A container keeps the bind mounts and environment it was created with, so a
 * changed `.env` means nothing at all until the containers are replaced —
 * which is why editing a media path used to leave the apps looking at the old
 * one until somebody ran the CLI. `compose up -d` does the replacing, and does
 * it only where needed: it compares each service against the file and leaves
 * alone anything whose resolved config did not actually move.
 *
 * Two things are deliberately left out:
 *
 *   - modules that are not installed — there is nothing to recreate, and the
 *     new value applies the moment they are;
 *   - `dashboard` — it is the container serving this request, and replacing it
 *     mid-response kills the reply, so the page would report a failure for
 *     something that in fact worked. It is named in `manual` instead.
 */
async function applySaved(keys) {
  const affected = await config.modulesUsing(keys);
  if (!affected.length) return { restarting: [], failed: [], manual: [] };

  const containers = await docker.listContainers().catch(() => []);
  const { modules } = modulesLib.withContainers(
    (await modulesLib.loadAll()).modules, containers, HOST_ADDRESS,
  );
  const installed = new Set(modules.filter((m) => m.installed).map((m) => m.id));

  const restarting = [];
  const failed = [];
  const manual = [];
  const selfRestart = [];
  for (const id of affected) {
    if (!installed.has(id)) continue;
    if (id === 'dashboard') { selfRestart.push(id); continue; }
    try {
      // No activity entry is written here on purpose: recreating a container
      // emits real Docker create/start events, and the activity feed is fed by
      // that stream. A hand-written note would show the same thing twice.
      await composeLib.start(id);
      restarting.push(id);
    } catch (err) {
      // The likeliest cause by far is a bind source that is not mounted, so
      // pass compose's own words through rather than a generic failure.
      failed.push({ id, error: (err.stderr || err.message || '').trim().split('\n').pop() });
    }
  }
  // The dashboard reads TZ and the paths too, so a setting it uses means it
  // has to be recreated like everything else — and "restart it yourself" is
  // the same trip through a terminal this settings page exists to remove.
  //
  // It cannot run the recreate itself: compose STOPS the container first,
  // which kills the process running compose, so the create half is never
  // sent and the dashboard goes down and stays down. Delaying it does not
  // help — the problem is not timing, it is that the process dies mid
  // command. lib/compose.js hands the job to a detached sibling container
  // that outlives this one.
  //
  // If the helper cannot even be started, say so rather than leaving someone
  // to discover it: the old `manual` wording is exactly right then.
  if (selfRestart.length) {
    const me = containers.find((c) => c.service === 'dashboard' && c.state !== 'stopped');
    try {
      if (!me || !me.image) throw new Error('cannot tell which image this dashboard is running');
      await composeLib.selfRecreate(me.image);
      restarting.push(...selfRestart);
    } catch (err) {
      console.error(`[homebox] could not schedule the dashboard's own recreate: ${err.message}`);
      manual.push(...selfRestart);
    }
  }

  return { restarting, failed, manual };
}

async function apiModules() {
  const [{ modules, errors }, containers] = await Promise.all([
    modulesLib.loadAll(),
    docker.listContainers().catch(() => []),
  ]);
  // Figures come from the background sampler, never from a blocking read —
  // /stats takes a second per container by design.
  for (const c of containers) Object.assign(c, stats.get(c.name));
  const enabled = modulesLib.enabledIds(modules);
  const { modules: withState, unclaimed } = modulesLib.withContainers(modules, containers, HOST_ADDRESS);
  return {
    modules: withState.map((m) => ({ ...m, enabled: enabled.has(m.id) })),
    unclaimed,
    categories: modulesLib.CATEGORIES,
    host: HOST_ADDRESS,
    errors,
    busy: [...inFlight],
  };
}

/* ------------------------------------------------------------------ actions */

// One operation per module at a time. Two overlapping `compose up` runs on
// the same project fight over the same containers and leave one of them in a
// half-created state.
const inFlight = new Set();

const ACTIONS = {
  install: composeLib.install,
  start: composeLib.start,
  stop: composeLib.stop,
  restart: composeLib.restart,
  update: composeLib.update,
  // Uninstall keeps modules/<id>/config so a reinstall comes back with its
  // settings; purge deletes it and is the only irreversible action here.
  remove: composeLib.down,
  purge: composeLib.purge,
};

async function runAction(id, action, onLine = null) {
  const fn = ACTIONS[action];
  if (!fn) return { status: 400, body: { error: `unknown action: ${action}` } };
  if (!composeLib.ID_PATTERN.test(id)) return { status: 400, body: { error: 'invalid module id' } };

  const { modules } = await modulesLib.loadAll();
  const mod = modules.find((m) => m.id === id);
  if (!mod) return { status: 404, body: { error: `no such module: ${id}` } };
  // Stopping the proxy or the dashboard from the dashboard is a way to lose
  // the page you are clicking in. Required modules are restart-only.
  if (mod.required && ['stop', 'remove', 'purge'].includes(action)) {
    return { status: 409, body: { error: `${mod.title} is required and cannot be stopped from here` } };
  }
  if (inFlight.has(id)) {
    return { status: 409, body: { error: `${mod.title} is already busy` } };
  }
  // The old Media Stack and its six successors claim the same container
  // names; neither may be installed beside the other. See lib/modules.js.
  if (action === 'install') {
    const containers = await docker.listContainers().catch(() => []);
    const live = modulesLib.withContainers(modules, containers, HOST_ADDRESS).modules;
    const blocked = modulesLib.installBlocker(live.find((m) => m.id === id), live);
    if (blocked) return { status: 409, body: { error: blocked } };
  }

  inFlight.add(id);
  const started = Date.now();
  try {
    const result = await fn(id, { onLine });
    const output = typeof result === 'string' ? result : `${result.stdout || ''}${result.stderr || ''}`;
    activity.note({ name: id, action, level: 'info', module: id });
    return { status: 200, body: { ok: true, id, action, seconds: Math.round((Date.now() - started) / 1000), output } };
  } catch (err) {
    activity.note({ name: id, action: `${action} failed`, level: 'error', module: id });
    return {
      status: 500,
      body: { ok: false, id, action, error: err.message, output: `${err.stdout || ''}${err.stderr || ''}` },
    };
  } finally {
    inFlight.delete(id);
  }
}

/* -------------------------------------------------------------------- SSE */

function serveEvents(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(': connected\n\n');

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  let closed = false;
  const tick = async () => {
    if (closed) return;
    try {
      send('summary', await apiSummary());
    } catch (err) {
      send('error', { message: err.message });
    }
  };
  tick();
  const timer = setInterval(tick, 5000);
  const unsubscribe = activity.subscribe((entry) => send('activity', entry));

  req.on('close', () => {
    closed = true;
    clearInterval(timer);
    unsubscribe();
  });
}

const MAX_BODY = 16384;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let done = false;
    // Rejecting the promise does NOT stop the sender. The old version called
    // reject() past the limit and then kept appending every further chunk to
    // the same string, so the one thing the limit existed to prevent — a body
    // that grows without bound on an endpoint reachable before login — went on
    // happening, quietly, after the caller had already been told no. The
    // request is destroyed here instead, which is what ends it.
    const stop = (message) => {
      if (done) return;
      done = true;
      data = '';
      req.destroy();
      reject(new Error(message));
    };
    req.on('data', (chunk) => {
      if (done) return;
      data += chunk;
      // Every POST here is a few dozen bytes; anything larger is a bug or an
      // attempt to exhaust memory on an unauthenticated endpoint.
      if (data.length > MAX_BODY) stop('body too large');
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', (err) => { if (!done) { done = true; reject(err); } });
  });
}

const server = http.createServer(async (req, res) => {
  // Parsed INSIDE the boundary, and against a fixed base.
  //
  // This used to read `http://${req.headers.host}`, above the try. A request
  // with a Host header that is not a valid authority — `Host: [` is enough —
  // made the URL constructor throw, and because this handler is async that
  // became an unhandled rejection with nothing to catch it: Node 22 ends the
  // process on those. Anyone who could reach the port could stop the
  // dashboard with one line of netcat, repeatedly, faster than Docker
  // restarts it.
  //
  // Nothing here needs the Host. Every route is a path, and the one place
  // that cares about the address the box answers on reads it from .env.
  let url;
  try {
    url = new URL(req.url, 'http://podhouse.invalid');
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('bad request target');
    return;
  }
  const route = url.pathname;

  try {
    // ---------------------------------------------------------------------
    // THE GATE.
    //
    // Deny by default: everything below this block requires a session, and a
    // new route is protected the moment it is added rather than the moment
    // someone remembers to protect it. Only what is needed to log in, and the
    // assets the login screen itself is made of, are open.
    //
    // The login screen lives in index.html, so index.html and the CSS/JS it
    // pulls have to be reachable while signed out. They contain no data —
    // every value on the page arrives from an /api call that IS gated.
    // ---------------------------------------------------------------------
    // Liveness. Deliberately says nothing beyond "this process answers".
    if (route === '/healthz') {
      return sendJson(res, 200, { ok: true, version: VERSION });
    }

    if (route.startsWith('/api/auth/')) {
      try {
        if (route === '/api/auth/status') return sendJson(res, 200, await auth.status(req));
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });

        if (route === '/api/auth/claim') {
          const claimed = await auth.claim(req, await readBody(req));
          res.setHeader('set-cookie', claimed.cookie);
          activity.note({ name: 'dashboard', action: 'claimed', level: 'info' });
          // The write token is returned HERE and nowhere else — an endpoint
          // that handed it out on presentation of the cookie would hand it to
          // whoever stole the cookie. See lib/auth.js.
          return sendJson(res, 200, { ok: true, token: claimed.token });
        }
        if (route === '/api/auth/login') {
          const signedIn = await auth.login(req, await readBody(req));
          res.setHeader('set-cookie', signedIn.cookie);
          return sendJson(res, 200, { ok: true, token: signedIn.token });
        }
        if (route === '/api/auth/logout') {
          const { cookie } = await auth.logout(req);
          res.setHeader('set-cookie', cookie);
          return sendJson(res, 200, { ok: true });
        }
        // Changing a password is not a way IN, so it needs a session.
        if (route === '/api/auth/password') {
          if (!(await auth.isAuthenticated(req))) return sendJson(res, 401, { error: 'not signed in' });
          const result = await auth.changePassword(req, await readBody(req));
          res.setHeader('set-cookie', result.cookie);
          return sendJson(res, 200, {
            ok: true, token: result.token, otherSessionsSignedOut: result.otherSessionsSignedOut,
          });
        }
        return sendJson(res, 404, { error: 'no such endpoint' });
      } catch (err) {
        return sendJson(res, err.status || 400, { ok: false, error: err.message });
      }
    }

    if (!PUBLIC_PATHS.has(route) && !(await auth.isAuthenticated(req))) {
      // 401 for the API so the page can bounce to the login screen; for a
      // document request, serve the page itself, which shows the login screen
      // on its own once /api/auth/status answers.
      if (route.startsWith('/api/')) return sendJson(res, 401, { error: 'not signed in' });
      return serveIndex(res);
    }

    // Anything that CHANGES the box needs the second half of the session.
    //
    // The cookie travels to every app on this host, because cookies ignore
    // ports — see lib/auth.js. The token does not: it lives in this origin's
    // localStorage and arrives in a header the page adds. So a cookie taken by
    // a compromised app on another port can still read the Overview, and can
    // no longer install, remove, restore or change the password.
    //
    // GET and HEAD are deliberately outside this: they are what a browser
    // sends on its own, and holding a read behind a header only breaks the
    // page. The writes are the ones worth protecting.
    if (route.startsWith('/api/') && !['GET', 'HEAD'].includes(req.method)) {
      if (!(await auth.hasWriteToken(req))) {
        return sendJson(res, 403, {
          error: 'this session cannot make changes — sign in again on this page',
          code: 'stale-session',
        });
      }
    }

    // POST /api/containers/<name>/<action> — the Running list's buttons.
    const containerAction = /^\/api\/containers\/([^/]+)\/([^/]+)$/.exec(route);
    if (containerAction) {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
      const name = await resolveContainerName(decodeURIComponent(containerAction[1]));
      if (!name) return sendJson(res, 404, { error: 'no such container' });
      const verb = containerAction[2];
      try {
        await composeLib.containerAction(name, verb);
        activity.note({ name, action: verb, level: 'info' });
        return sendJson(res, 200, { ok: true, name, action: verb });
      } catch (err) {
        return sendJson(res, 500, { ok: false, name, action: verb, error: err.message });
      }
    }

    // POST /api/modules/<id>/<action>/stream
    //
    // The plain route below answers once, after the whole install. That is a
    // minute or more of silence for a pull, which is exactly when someone
    // decides it has hung. This one streams compose's own output line by line
    // as NDJSON, so the page can show the work happening.
    //
    // Chunked POST rather than SSE: EventSource is GET-only, and a GET that
    // installs software is a URL a prefetch or a history entry can fire.
    const streamed = /^\/api\/modules\/([^/]+)\/([^/]+)\/stream$/.exec(route);
    if (streamed) {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
      res.writeHead(200, {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-store',
        'x-accel-buffering': 'no',
      });
      const send = (obj) => { if (!res.writableEnded) res.write(`${JSON.stringify(obj)}
`); };
      const result = await runAction(
        decodeURIComponent(streamed[1]), streamed[2],
        (line, isErr) => send({ line, err: isErr }),
      );
      send({ done: true, status: result.status, ...result.body });
      return res.end();
    }

    // POST /api/modules/<id>/<action>
    const action = /^\/api\/modules\/([^/]+)\/([^/]+)$/.exec(route);
    if (action) {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
      const result = await runAction(decodeURIComponent(action[1]), action[2]);
      return sendJson(res, result.status, result.body);
    }

    // --- Reset an app's own login ---
    //
    // GET  /api/reset   which installed apps this build can unlock
    // POST /api/reset   {module, service} — streams, it restarts a container
    //
    // This never reveals a password. It puts an app back into a state where
    // the user can set a NEW one; see lib/reset.js for why the strategies are
    // a fixed set rather than something a module can declare freely.
    if (route.startsWith('/api/reset')) {
      const tail = route.slice('/api/reset'.length).replace(/^\//, '');
      try {
        if (!tail && req.method === 'GET') {
          return sendJson(res, 200, { apps: await reset.list(await docker.listContainers()) });
        }
        if (!tail && req.method === 'POST') {
          const body = await readBody(req);
          res.writeHead(200, {
            'content-type': 'application/x-ndjson; charset=utf-8',
            'cache-control': 'no-store',
            'x-accel-buffering': 'no',
          });
          const send = (obj) => {
            if (!res.writableEnded && !res.destroyed) res.write(`${JSON.stringify(obj)}\n`);
          };
          try {
            const result = await reset.run(body, { onLine: (line, err) => send({ line, err }) });
            activity.note({ name: result.title, action: 'login reset', level: 'info' });
            send({ done: true, ...result });
          } catch (err) {
            send({ line: err.message, err: true });
            send({ done: true, ok: false, error: err.message });
          }
          return res.end();
        }
        return sendJson(res, 404, { error: 'no such endpoint' });
      } catch (err) {
        return sendJson(res, err.status || 500, { error: err.message });
      }
    }

    // --- Remote storage ---
    //
    // GET  /api/storage          what is mounted
    // POST /api/storage/probe    {kind, server} — ask an NFS server what it exports
    // POST /api/storage/mount    the form — streams, because it installs a
    //                            package and reloads systemd
    // POST /api/storage/unmount  {mountpoint}
    //
    // These reach the HOST through a privileged helper container. That is a
    // real capability and it is deliberate — see the header of lib/storage.js
    // for why it does not widen what this process could already do, and for
    // what is validated before any of it leaves here.
    if (route.startsWith('/api/storage')) {
      const tail = route.slice('/api/storage'.length).replace(/^\//, '');
      try {
        if (!tail && req.method === 'GET') return sendJson(res, 200, await storage.list());

        if (tail === 'probe' && req.method === 'POST') {
          return sendJson(res, 200, await storage.probe(await readBody(req)));
        }

        if (tail === 'unmount' && req.method === 'POST') {
          const body = await readBody(req);
          const result = await storage.unmount(body);
          activity.note({ name: body.mountpoint, action: 'unmounted', level: 'info' });
          return sendJson(res, 200, { ok: true, ...result });
        }

        if (tail === 'mount' && req.method === 'POST') {
          const body = await readBody(req);
          res.writeHead(200, {
            'content-type': 'application/x-ndjson; charset=utf-8',
            'cache-control': 'no-store',
            'x-accel-buffering': 'no',
          });
          const send = (obj) => { if (!res.writableEnded) res.write(`${JSON.stringify(obj)}\n`); };
          try {
            const result = await storage.mount(body, { onLine: (line, err) => send({ line, err }) });
            activity.note({ name: result.mountpoint, action: 'mounted', level: 'info' });
            send({ done: true, ok: true, ...result });
          } catch (err) {
            send({ line: err.message, err: true });
            send({ done: true, ok: false, error: err.message });
          }
          return res.end();
        }

        return sendJson(res, 404, { error: 'no such endpoint' });
      } catch (err) {
        return sendJson(res, err.status || 500, { error: err.message });
      }
    }

    // --- Live activity ---
    //
    // What the installed apps are doing right now: transfer rates, queues,
    // and what is due out. Read-only, and best-effort by design — see
    // lib/insights.js for why a source that cannot be reached says so rather
    // than reporting a zero. POST is the same read with the caches dropped,
    // which is what the card's own refresh button wants.
    if (route === '/api/insights') {
      if (req.method === 'POST') insights.invalidate();
      try {
        return sendJson(res, 200, await insights.snapshot());
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
    }

    // One poster, from Radarr or Sonarr, through this process.
    //
    // The page's own CSP allows images from 'self' and nothing else, which is
    // the rule that decides the shape of this: the alternative is thetvdb.com
    // in an <img>, and that both breaks the policy and tells someone else's
    // server what this house is watching.
    //
    // Two values reach the fetcher, a service NAME from a set of two and an
    // integer, and lib/insights.js checks both again before it builds a path.
    // Nothing here accepts a host, a path or a URL — an image endpoint that
    // did would be a request forgery with a friendly name.
    if (route === '/api/insights/art') {
      const service = url.searchParams.get('service') || '';
      const id = Number(url.searchParams.get('id'));
      try {
        const body = await insights.poster(service, id);
        res.writeHead(200, {
          ...BASE_HEADERS,
          'content-type': 'image/jpeg',
          'content-length': body.length,
          // The artwork for a series does not change, and this card repolls
          // every ten seconds.
          'cache-control': 'private, max-age=86400',
        });
        return res.end(body);
      } catch (err) {
        // A missing poster is ordinary — a series added a minute ago, or an
        // *arr that has not reached its artwork source. The page falls back
        // to a monogram, so this must not read as a fault.
        return sendJson(res, 404, { error: err.message });
      }
    }

    // --- Podhouse itself ---
    //
    // GET  /api/platform          cached answer + progress + history
    // POST /api/platform/check    ask the release manifest now
    // POST /api/platform/upgrade  {to?} — starts it and returns immediately
    //
    // Deliberately NOT an NDJSON stream, which is what every other long
    // operation here uses. This one rebuilds the dashboard, so the connection
    // carrying the stream is killed by the work it is reporting on. The
    // progress goes to a file instead and the page polls it — the only
    // channel that survives the thing it is watching.
    if (route.startsWith('/api/platform')) {
      const tail = route.slice('/api/platform'.length).replace(/^\//, '');
      try {
        if (!tail && req.method === 'GET') return sendJson(res, 200, await platform.status());

        if (tail === 'check' && req.method === 'POST') {
          return sendJson(res, 200, { ok: true, ...(await platform.check({ force: true })) });
        }

        if (tail === 'upgrade' && req.method === 'POST') {
          const body = await readBody(req);
          const to = body.to ? String(body.to).trim() : null;
          const started = await platform.upgrade({ to });
          // 202: accepted and running elsewhere. The caller polls GET
          // /api/platform, and must expect this server to stop answering
          // partway through.
          return sendJson(res, 202, started);
        }
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
      return sendJson(res, 404, { error: 'no such platform route' });
    }

    // --- Housekeeping ---
    //
    // POST /api/prune-images   delete layers left behind by rebuilds.
    //
    // Dangling images only — see docker.pruneDangling(). A tagged image that
    // no container currently uses is an app you stopped, or the version an
    // update would roll back to, and this must never be the button that
    // deletes those.
    if (route === '/api/prune-images' && req.method === 'POST') {
      try {
        // Through the worker: this process holds no socket, and the read-only
        // proxy it does hold refuses every POST. See the op in worker.js.
        const result = await worker.call('images.pruneDangling');
        activity.note({ name: 'dashboard', action: 'cleared leftover image layers', level: 'info' });
        return sendJson(res, 200, { ok: true, ...result });
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: err.message });
      }
    }

    // --- Updates ---
    //
    // GET  /api/updates          the cached answer + history (never checks)
    // POST /api/updates/check    ask the registries now
    // POST /api/updates/apply    {container: "<name>" | "all"} — streams NDJSON
    //
    // The check is a POST even though it reads nothing on this box: it makes
    // a dozen outbound registry requests, and a GET is something a browser
    // prefetch or a refresh can fire on its own.
    if (route.startsWith('/api/updates')) {
      const tail = route.slice('/api/updates'.length).replace(/^\//, '');
      try {
        if (!tail && req.method === 'GET') return sendJson(res, 200, await updates.status());

        if (tail === 'check' && req.method === 'POST') {
          return sendJson(res, 200, { ok: true, ...(await updates.check()) });
        }

        // Moving to a newer VERSION. Separate from `apply` because it is a
        // different operation with a different risk: a rebuild rolls back by
        // re-tagging an image still on disk, while a version change may have
        // migrated a database on first start. See updates.upgrade().
        if (tail === 'upgrade' && req.method === 'POST') {
          const body = await readBody(req);
          const which = String(body.container || '').trim();
          if (!which) return sendJson(res, 400, { error: 'which container?' });
          res.writeHead(200, {
            'content-type': 'application/x-ndjson; charset=utf-8',
            'cache-control': 'no-store',
            'x-accel-buffering': 'no',
          });
          const send = (obj) => { if (!res.writableEnded) res.write(`${JSON.stringify(obj)}\n`); };
          try {
            const result = await updates.upgrade(which, { onLine: (line, err) => send({ line, err }) });
            send({ done: true, ...result });
          } catch (err) {
            send({ line: err.message, err: true });
            send({ done: true, ok: false, error: err.message });
          }
          return res.end();
        }

        if (tail === 'apply' && req.method === 'POST') {
          const body = await readBody(req);
          const which = String(body.container || '').trim();
          if (!which) return sendJson(res, 400, { error: 'which container?' });

          // Same shape as the module action stream: an update pulls an image
          // and waits on a healthcheck, which is minutes of silence unless
          // the page can watch the work happen.
          res.writeHead(200, {
            'content-type': 'application/x-ndjson; charset=utf-8',
            'cache-control': 'no-store',
            'x-accel-buffering': 'no',
          });
          const send = (obj) => { if (!res.writableEnded) res.write(`${JSON.stringify(obj)}\n`); };
          try {
            const result = await updates.apply(which, {
              onLine: (line, isErr) => send({ line, err: isErr }),
            });
            send({ done: true, ...result });
          } catch (err) {
            send({ line: err.message, err: true });
            send({ done: true, ok: false, error: err.message });
          }
          return res.end();
        }

        return sendJson(res, 404, { error: 'no such endpoint' });
      } catch (err) {
        return sendJson(res, err.status || 500, { error: err.message });
      }
    }

    // --- Backup Center ---
    if (route.startsWith('/api/backup')) {
      const action = route.slice('/api/backup'.length).replace(/^\//, '');
      try {
        if (route === '/api/backup' && req.method === 'GET') {
          return sendJson(res, 200, await backup.status());
        }
        if (action === 'create' && req.method === 'POST') {
          const body = await readBody(req);
          const made = await backup.create({ kind: body.kind });
          activity.note({ name: made.name, action: 'backup', level: 'info' });
          return sendJson(res, 200, { ok: true, ...made });
        }
        // The exact copy stops apps while it reads them, so it takes long
        // enough that a silent wait would read as a hang.
        if (action === 'create/stream' && req.method === 'POST') {
          const body = await readBody(req);
          res.writeHead(200, {
            'content-type': 'application/x-ndjson; charset=utf-8',
            'cache-control': 'no-store',
            'x-accel-buffering': 'no',
          });
          const send = (obj) => { if (!res.writableEnded) res.write(`${JSON.stringify(obj)}\n`); };
          try {
            const made = await backup.create({ kind: body.kind, quiesce: body.quiesce === true, onLine: (line) => send({ line }) });
            activity.note({ name: made.name, action: body.quiesce ? 'backup (apps stopped)' : 'backup', level: 'info' });
            send({ done: true, ok: true, ...made });
          } catch (err) {
            activity.note({ name: 'backup', action: 'backup failed', level: 'error' });
            send({ done: true, ok: false, error: err.message, hint: err.hint || null });
          }
          return res.end();
        }
        if (action === 'delete' && req.method === 'POST') {
          const body = await readBody(req);
          await backup.remove(body.name);
          return sendJson(res, 200, { ok: true, name: body.name });
        }
        if (action === 'verify' && req.method === 'POST') {
          const body = await readBody(req);
          return sendJson(res, 200, { ok: true, ...(await backup.verify(body.name)) });
        }
        if (action === 'key' && req.method === 'POST') {
          // POST, not GET: a secret must not be fetchable by a link, a
          // prefetch or anything that lands in a browser history.
          return sendJson(res, 200, backup.revealKey());
        }
        if (action === 'schedule' && req.method === 'POST') {
          return sendJson(res, 200, await backup.setSchedule(await readBody(req)));
        }
        if (action.startsWith('download/') && req.method === 'GET') {
          const name = decodeURIComponent(action.slice('download/'.length));
          const file = backup.resolveName(name);
          const stat = await fsp.stat(file);
          res.writeHead(200, {
            'content-type': 'application/octet-stream',
            'content-length': stat.size,
            'content-disposition': `attachment; filename="${name}"`,
          });
          return streamFile(res, file);
        }
        return sendJson(res, 404, { error: 'no such endpoint' });
      } catch (err) {
        return sendJson(res, err.name === 'BackupError' ? 400 : 500, { error: err.message, hint: err.hint || null });
      }
    }

    // --- putting a backup back ---
    //
    // Four steps, each its own request, because each one is a decision: get
    // the archive here, read what is in it, choose, then apply. Nothing
    // before the last one writes anything outside state/restore. See
    // lib/restore.js for why the shape is this careful.
    if (route.startsWith('/api/restore')) {
      const action = route.slice('/api/restore'.length).replace(/^\//, '');
      try {
        if (!action && req.method === 'GET') return sendJson(res, 200, { staged: await restore.list() });

        if (action === 'upload' && req.method === 'POST') {
          // Straight from the socket to disk: readBody caps at 16KB, and an
          // archive is hundreds of megabytes.
          const id = restore.id16();
          const name = String(url.searchParams.get('name') || 'uploaded archive').slice(0, 120);
          const got = await restore.receive(req, id);
          await restore.writeMeta(id, { createdAt: Date.now(), source: 'upload', fileName: name });
          return sendJson(res, 200, { ok: true, ...got });
        }
        if (action === 'from-archive' && req.method === 'POST') {
          const body = await readBody(req);
          const got = await restore.fromExisting(String(body.name || ''));
          await restore.writeMeta(got.id, { createdAt: Date.now(), source: 'box', fileName: String(body.name || '') });
          return sendJson(res, 200, { ok: true, ...got });
        }
        if (action === 'inspect' && req.method === 'POST') {
          const body = await readBody(req);
          return sendJson(res, 200, { ok: true, plan: await restore.inspect(body.id) });
        }
        if (action === 'discard' && req.method === 'POST') {
          const body = await readBody(req);
          return sendJson(res, 200, await restore.discard(body.id));
        }
        // The only route here that changes the box, and it streams: a restore
        // stops apps, copies over them and starts them again, and watching
        // that happen is the difference between waiting and worrying.
        if (action === 'apply/stream' && req.method === 'POST') {
          const body = await readBody(req);
          res.writeHead(200, {
            'content-type': 'application/x-ndjson; charset=utf-8',
            'cache-control': 'no-store',
            'x-accel-buffering': 'no',
          });
          const send = (obj) => { if (!res.writableEnded) res.write(`${JSON.stringify(obj)}\n`); };
          try {
            const done = await restore.apply(body.id, body, (line) => send({ line }));
            activity.note({ name: 'restore', action: `restored ${done.apps.join(', ') || 'settings'}`, level: 'info' });
            send({ done: true, ok: true, ...done });
          } catch (err) {
            activity.note({ name: 'restore', action: 'restore failed', level: 'error' });
            send({ done: true, ok: false, error: err.message, hint: err.hint || null });
          }
          return res.end();
        }
        return sendJson(res, 404, { error: 'no such endpoint' });
      } catch (err) {
        const known = err.name === 'RestoreError' || err.name === 'BackupError';
        return sendJson(res, known ? 400 : 500, { error: err.message, hint: err.hint || null });
      }
    }

    // --- raw .env editor ---
    if (route === '/api/config') {
      if (req.method === 'GET') return sendJson(res, 200, await config.schema());
      if (req.method === 'POST') {
        try {
          const saved = await config.save((await readBody(req)).changes);
          return sendJson(res, 200, { ok: true, ...saved, ...(await applySaved(saved.applied)) });
        } catch (err) {
          return sendJson(res, 400, { ok: false, error: err.message });
        }
      }
      return sendJson(res, 405, { error: 'method not allowed' });
    }

    // --- App Store contents: module text, and user-added apps ---
    if (route.startsWith('/api/catalog')) {
      if (route === '/api/catalog' && req.method === 'GET') return sendJson(res, 200, await catalog.read());
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
      try {
        const body = await readBody(req);
        if (route === '/api/catalog/override') {
          return sendJson(res, 200, { ok: true, ...(await catalog.saveOverride(body.id, body)) });
        }
        if (route === '/api/catalog/override/reset') {
          return sendJson(res, 200, { ok: true, ...(await catalog.resetOverride(body.id)) });
        }
        if (route === '/api/catalog/app') {
          return sendJson(res, 200, { ok: true, ...(await catalog.createApp(body)) });
        }
        if (route === '/api/catalog/app/delete') {
          // Whether it is installed is decided here, from Docker, not taken
          // from the page: the button that sends this is drawn from a list
          // that may be seconds out of date.
          const containers = await docker.listContainers().catch(() => []);
          const { modules } = modulesLib.withContainers(
            (await modulesLib.loadAll()).modules, containers, HOST_ADDRESS,
          );
          const mod = modules.find((m) => m.id === body.id);
          return sendJson(res, 200, { ok: true, ...(await catalog.deleteApp(body.id, { installed: !!(mod && mod.installed) })) });
        }
        return sendJson(res, 404, { error: 'no such endpoint' });
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: err.message });
      }
    }

    // --- Quick Access bookmarks ---
    if (route.startsWith('/api/bookmarks')) {
      try {
        if (route === '/api/bookmarks' && req.method === 'GET') return sendJson(res, 200, await bookmarks.read());
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
        const body = await readBody(req);
        if (route === '/api/bookmarks') return sendJson(res, 200, { ok: true, item: await bookmarks.save(body) });
        if (route === '/api/bookmarks/delete') return sendJson(res, 200, { ok: true, ...(await bookmarks.remove(body.id)) });
        if (route === '/api/bookmarks/reorder') return sendJson(res, 200, { ok: true, ...(await bookmarks.reorder(body.ids)) });
        return sendJson(res, 404, { error: 'no such endpoint' });
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: err.message });
      }
    }

    if (route === '/api/summary') return sendJson(res, 200, await apiSummary());
    if (route === '/api/modules') return sendJson(res, 200, await apiModules());
    if (route === '/api/containers') return sendJson(res, 200, { containers: await docker.listContainers() });
    if (route === '/api/metrics') return sendJson(res, 200, await hostMetrics.snapshot());
    if (route === '/api/activity') {
      return sendJson(res, 200, { entries: activity.list(Number(url.searchParams.get('limit')) || 50) });
    }
    if (route === '/api/logs') {
      const name = await resolveContainerName(url.searchParams.get('name'));
      if (!name) return sendJson(res, 404, { error: 'no such container' });
      const tail = Math.min(Math.max(Number(url.searchParams.get('tail')) || 200, 1), 2000);
      // Timestamps on: the Live Logs page draws one row per physical line, and
      // the Docker prefix is what lets a fragment of a multi-line message
      // read as a row of its own rather than as debris from the line above.
      // The box's timezone travels WITH the logs. The page also learns it from
      // the summary, but that arrives over the event stream, and a page opened
      // straight onto Live Logs can render lines before the first event lands.
      return sendJson(res, 200, {
        name,
        tail,
        timezone: process.env.TZ || 'UTC',
        text: await docker.logs(name, tail, { timestamps: true }),
      });
    }
    if (route === '/api/prefs') {
      if (req.method === 'GET') {
        // Validated on the way OUT as well as in: a prefs.json written by an
        // older version has keys this one does not know, and handing those
        // straight to the page puts "undefined" in a DOM attribute.
        return sendJson(res, 200, cleanPrefs(await state.readJson('prefs.json', DEFAULT_PREFS)));
      }
      if (req.method === 'POST') {
        const prefs = cleanPrefs(await readBody(req));
        await state.writeJson('prefs.json', prefs);
        return sendJson(res, 200, prefs);
      }
      return sendJson(res, 405, { error: 'method not allowed' });
    }
    if (route === '/api/events') return serveEvents(req, res);
    if (route.startsWith('/api/')) return sendJson(res, 404, { error: 'no such endpoint' });

    return serveStatic(res, route);
  } catch (err) {
    return sendJson(res, 500, { error: err.message });
  }
});

/**
 * Last resort, not a policy.
 *
 * Every request is inside a try, and the one path that escaped it — parsing a
 * malformed Host — is fixed above. This is what remains: a rejection from a
 * background timer, a stream that fails after its headers went out, a bug
 * nobody has hit yet. Node 22 ends the process on an unhandled rejection, and
 * a dashboard that exits is a box whose owner cannot reach anything, so this
 * logs loudly and keeps serving.
 *
 * It is deliberately noisy: a silent catch-all turns a bug into a mystery.
 */
for (const kind of ['unhandledRejection', 'uncaughtException']) {
  process.on(kind, (err) => {
    console.error(`[homebox] ${kind}:`, err && err.stack ? err.stack : err);
  });
}

async function main() {
  hostMetrics.start();
  await activity.load();
  // An exact-copy backup stops apps while it reads them. If the box lost power
  // in that window, they are still down: the list of what to start is on disk.
  // Finish that recovery before schedules or requests can start new work.
  await backup.resumeAfterQuiesce().catch((err) => {
    console.warn(`[homebox] backup recovery failed: ${err.message}`);
  });
  backup.startScheduler();
  if (await docker.reachable()) {
    activity.start();
    stats.start(async () => {
      const containers = await docker.listContainers().catch(() => []);
      return containers.filter((c) => c.state !== 'stopped').map((c) => c.name);
    });
  } else {
    console.warn('[homebox] docker socket unreachable — status and logs will be empty');
  }
  // The question used to be whether `docker compose` worked from in here. It
  // no longer can: this container holds no socket. What matters now is whether
  // the privileged worker is answering, because nothing installs, starts or
  // stops without it.
  if (!(await composeLib.available())) {
    console.warn(`[homebox] the privileged worker is not answering on ${worker.SOCKET_PATH}`);
    console.warn('[homebox] installing, starting and stopping apps will fail until dashboard-worker is running');
  }
  server.listen(PORT, () => {
    console.log(`[homebox] v${VERSION} listening on :${PORT} (root ${state.ROOT}, host ${HOST_ADDRESS})`);
  });

  scheduleUpdateChecks();
}

/**
 * Check for updates on a timer, so the answer is waiting rather than fetched
 * when somebody happens to open the tab.
 *
 * It only ever CHECKS. Nothing is pulled, nothing is recreated, nothing is
 * decided — the buttons stay the only way anything changes on this box. An
 * unattended dashboard that upgrades software by itself is a dashboard you
 * cannot leave running.
 *
 * The first run is delayed: a box that has just booted is busy starting its
 * containers, and a dozen registry round-trips is not what it needs in the
 * first minute.
 */
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;   // four times a day
const FIRST_CHECK_MS = 5 * 60 * 1000;

/**
 * The manifest is read on its OWN, much shorter timer.
 *
 * These two checks look alike and cost nothing alike. The image check opens a
 * connection to a registry for every container on the box — that belongs on a
 * six-hour timer. The platform check is one conditional GET for a 200-byte
 * static file that answers 304 almost every time.
 *
 * Sharing the six-hour timer had a consequence nobody had counted: it is also
 * how long a FREEZE takes to reach a box. `docs/RELEASING.md` said "every box
 * stops offering the update within five minutes", and five minutes is only
 * `raw.githubusercontent.com`'s cache — the box's own poll sat behind it at
 * six hours. A release found to be bad could keep installing itself on other
 * people's machines all afternoon.
 *
 * Fifteen minutes is four requests an hour per box, nearly all of them 304s.
 * The emergency switch now means roughly what it says: 5 minutes of CDN plus
 * at most 15 of polling.
 */
const PLATFORM_CHECK_EVERY_MS = 15 * 60 * 1000;
const PLATFORM_FIRST_CHECK_MS = 60 * 1000;

function scheduleUpdateChecks() {
  const run = () => {
    updates.check()
      .then((r) => {
        const rebuilds = (r.available || []).length;
        const newer = (r.newVersions || []).length;
        if (rebuilds || newer) {
          console.log(`[homebox] update check: ${rebuilds} rebuild(s), ${newer} newer version(s)`);
        }
      })
      // A registry being unreachable is normal and not worth a stack trace in
      // the log of a box that is otherwise fine.
      .catch((err) => console.log(`[homebox] update check skipped: ${err.message}`));
  };

  // Podhouse itself. One outbound request to a static JSON file, and it is what
  // puts the dot in the nav without anybody opening the Updates tab to go
  // looking for it.
  //
  // force: this IS the thing that refreshes the cache. check() skips the
  // network when the cached answer is younger than STALE_AFTER_MS, which is
  // right for the UI — a page load should not fire a request — and exactly
  // wrong here. STALE_AFTER_MS and CHECK_EVERY_MS were both six hours, so the
  // scheduled run woke up to find a cache aged precisely at the threshold and
  // usually returned it untouched. The scheduler was guarded against doing its
  // only job, and a release could sit unnoticed indefinitely: anything that
  // refreshed the cache — opening the tab, `self-update --check` — pushed the
  // next real fetch out by another six hours.
  const runPlatform = () => platform.check({ force: true })
    .then((r) => {
      if (r.frozen) console.log(`[homebox] platform updates paused: ${r.reason}`);
      else if (r.updateAvailable) console.log(`[homebox] Podhouse ${r.latest} is available (on ${r.current})`);
    })
    .catch((err) => console.log(`[homebox] platform check skipped: ${err.message}`));

  setTimeout(run, FIRST_CHECK_MS).unref();
  setInterval(run, CHECK_EVERY_MS).unref();
  setTimeout(runPlatform, PLATFORM_FIRST_CHECK_MS).unref();
  setInterval(runPlatform, PLATFORM_CHECK_EVERY_MS).unref();
}

main().catch((err) => {
  console.error('[homebox] failed to start:', err);
  process.exit(1);
});
