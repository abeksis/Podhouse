'use strict';
/**
 * Connect the media apps to each other, so nobody copies API keys between
 * five web UIs.
 *
 *   Sonarr, Radarr  -> qBittorrent as the download client, plus a root folder
 *   Prowlarr        -> Sonarr and Radarr as applications (indexers added in
 *                      Prowlarr then reach both), FlareSolverr as a proxy
 *
 * Each of these apps is its own module and can be installed in any order, on
 * any day. So this is not an install step: it looks at what is running, makes
 * whichever links have both ends up, and remembers each link it made in
 * state/media-wired.json. A link is made ONCE. If the user later deletes the
 * download client in Sonarr, that was their choice and it stays deleted.
 *
 * A link whose target already has one of its kind (the user wired it by hand
 * before this existed) is recorded as done without adding a second copy.
 *
 * Indexers are never added. Which ones are legal to use is the user's call.
 */

const crypto = require('crypto');
const state = require('./state-store');
const docker = require('./docker');
const { arrApiKey, addressOf, readEnv } = require('./insights');

const STATE_FILE = 'media-wired.json';
const MEDIA_IDS = new Set(['sonarr', 'radarr', 'prowlarr', 'qbittorrent', 'flaresolverr']);

async function api(base, key, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'x-api-key': key, 'content-type': 'application/json', accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} answered ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

/** Take an implementation's schema and fill in the named fields. */
async function fromSchema(app, path, implementation, name, values) {
  const schema = await api(app.base, app.key, 'GET', `${path}/schema`);
  const item = schema.find((s) => s.implementation === implementation);
  if (!item) throw new Error(`${path} has no ${implementation} schema`);
  for (const f of item.fields) if (f.name in values) f.value = values[f.name];
  return { ...item, name, enable: true };
}

async function app(name, v) {
  return { base: await addressOf(name), key: await arrApiKey(name), v };
}

function downloadClient(arr, category) {
  return {
    id: `${arr}-qbittorrent`,
    needs: [arr, 'qbittorrent'],
    async run(env) {
      const a = await app(arr, 'v3');
      const have = await api(a.base, a.key, 'GET', '/api/v3/downloadclient');
      if (have.some((c) => c.implementation === 'QBittorrent')) return 'already had one';
      const body = await fromSchema(a, '/api/v3/downloadclient', 'QBittorrent', 'qBittorrent', {
        host: 'qbittorrent',
        port: 8080,
        username: env.HB_QBIT_USER || 'admin',
        password: env.HB_QBIT_PASS || '',
        [category.field]: category.value,
      });
      await api(a.base, a.key, 'POST', '/api/v3/downloadclient', body);
      // Its health check runs on a timer and would say "No download client"
      // for a while longer; ask it to look again now.
      await api(a.base, a.key, 'POST', '/api/v3/command', { name: 'CheckHealth' }).catch(() => {});
      return 'added';
    },
  };
}

function rootFolder(arr, envKey, fallback) {
  return {
    id: `${arr}-rootfolder`,
    needs: [arr],
    async run(env) {
      const a = await app(arr, 'v3');
      const have = await api(a.base, a.key, 'GET', '/api/v3/rootfolder');
      if (have.length) return 'already had one';
      // The pool is mounted at /data in every media container; setup.sh made the folder.
      const path = `/data/${(env[envKey] || fallback).replace(/^\/+|\/+$/g, '')}`;
      await api(a.base, a.key, 'POST', '/api/v3/rootfolder', { path });
      return `added ${path}`;
    },
  };
}

function prowlarrApp(arr, implementation) {
  return {
    id: `prowlarr-${arr}`,
    needs: ['prowlarr', arr],
    async run() {
      const p = await app('prowlarr', 'v1');
      const target = await app(arr, 'v3');
      const have = await api(p.base, p.key, 'GET', '/api/v1/applications');
      const old = have.find((x) => x.implementation === implementation);
      if (old) {
        // Due again means Sonarr/Radarr was reinstalled with a new key, and the
        // old link would 401 forever. Prowlarr masks the stored key, so no compare.
        const field = old.fields.find((f) => f.name === 'apiKey');
        if (field) field.value = target.key;
        await api(p.base, p.key, 'PUT', `/api/v1/applications/${old.id}`, old);
        return 'refreshed its API key';
      }
      const body = await fromSchema(p, '/api/v1/applications', implementation, implementation, {
        prowlarrUrl: p.base,
        baseUrl: target.base,
        apiKey: target.key,
      });
      body.syncLevel = 'fullSync';
      await api(p.base, p.key, 'POST', '/api/v1/applications', body);
      return 'added';
    },
  };
}

const flaresolverr = {
  id: 'prowlarr-flaresolverr',
  needs: ['prowlarr', 'flaresolverr'],
  async run() {
    const p = await app('prowlarr', 'v1');
    const have = await api(p.base, p.key, 'GET', '/api/v1/indexerproxy');
    if (have.some((x) => x.implementation === 'FlareSolverr')) return 'already had one';
    // Prowlarr sends an indexer through the proxy only when they share a tag.
    const tags = await api(p.base, p.key, 'GET', '/api/v1/tag');
    const tag = tags.find((t) => t.label === 'flaresolverr')
      || await api(p.base, p.key, 'POST', '/api/v1/tag', { label: 'flaresolverr' });
    const body = await fromSchema(p, '/api/v1/indexerproxy', 'FlareSolverr', 'FlareSolverr', {
      host: 'http://flaresolverr:8191/',
    });
    body.tags = [tag.id];
    await api(p.base, p.key, 'POST', '/api/v1/indexerproxy', body);
    return 'added (tag indexers "flaresolverr" to use it)';
  },
};

/**
 * qBittorrent ships saving into /config/Downloads, which no other app can see:
 * Sonarr/Radarr then report "directory does not appear to exist" and nothing
 * is imported. Point it at the shared pool, where an import is a hardlink.
 * Only while it is still on that default — a path the user chose stays.
 */
const qbitPaths = {
  id: 'qbittorrent-paths',
  needs: ['qbittorrent'],
  async run(env) {
    const base = await addressOf('qbittorrent');
    const login = await fetch(`${base}/api/v2/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', referer: base },
      body: new URLSearchParams({ username: env.HB_QBIT_USER || 'admin', password: env.HB_QBIT_PASS || '' }),
      signal: AbortSignal.timeout(20000),
    });
    // "SID" before qBittorrent 5.2, "QBT_SID_<port>" since.
    const sid = /\b(?:QBT_)?SID\w*=[^;]+/.exec(login.headers.get('set-cookie') || '');
    if (!sid) throw new Error(`qBittorrent login refused (${login.status})`);
    const headers = { cookie: sid[0], referer: base };
    const prefs = await (await fetch(`${base}/api/v2/app/preferences`, { headers })).json();
    if (!String(prefs.save_path).startsWith('/config')) return `left ${prefs.save_path}`;
    const dl = `/data/${(env.HB_DOWNLOADS || 'downloads').replace(/^\/+|\/+$/g, '')}`;
    const res = await fetch(`${base}/api/v2/app/setPreferences`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ json: JSON.stringify({ save_path: dl, temp_path: `${dl}/incomplete`, temp_path_enabled: true }) }),
    });
    if (!res.ok) throw new Error(`setPreferences answered ${res.status}`);
    return `save path ${dl}`;
  },
};

const LINKS = [
  qbitPaths,
  rootFolder('sonarr', 'HB_MEDIA_TV', 'media/tv'),
  rootFolder('radarr', 'HB_MEDIA_MOVIES', 'media/movies'),
  downloadClient('sonarr', { field: 'tvCategory', value: 'tv-sonarr' }),
  downloadClient('radarr', { field: 'movieCategory', value: 'radarr' }),
  prowlarrApp('sonarr', 'Sonarr'),
  prowlarrApp('radarr', 'Radarr'),
  flaresolverr,
];

/**
 * Which installs of the apps a link was made between. A purged and reinstalled
 * Sonarr starts empty with a new API key — by the CLI or the dashboard alike —
 * so a changed key makes its links due again. A hash, not the keys themselves.
 */
async function stampOf(link) {
  const keys = await Promise.all(link.needs.filter((n) => ['sonarr', 'radarr', 'prowlarr'].includes(n)).map(arrApiKey));
  return crypto.createHash('sha256').update(keys.join(':')).digest('hex').slice(0, 12);
}

let running = null;

/**
 * Make every link that is due. Returns [{ id, result }] for the ones made
 * this time. A link that fails (an app still starting) is retried next run.
 */
function wire() {
  if (!running) running = wireOnce().finally(() => { running = null; });
  return running;
}

async function wireOnce() {
  const containers = await docker.listContainers();
  const up = new Set(containers.filter((c) => c.rawState === 'running').map((c) => c.service));
  const done = await state.readJson(STATE_FILE, {});
  const env = readEnv();
  const made = [];
  for (const link of LINKS) {
    if (!link.needs.every((n) => up.has(n))) continue;
    try {
      const stamp = await stampOf(link);
      if (done[link.id] && done[link.id].stamp === stamp) continue;
      const result = await link.run(env);
      done[link.id] = { at: new Date().toISOString(), result, stamp };
      await state.writeJson(STATE_FILE, done);
      made.push({ id: link.id, result });
      console.log(`[media-wire] ${link.id}: ${result}`);
    } catch (err) {
      console.log(`[media-wire] ${link.id} not yet: ${err.message}`);
    }
  }
  return made;
}

/**
 * After an install the app needs a minute before its API answers. Try every
 * 15 seconds for 4 minutes; the regular timer covers anything slower.
 */
function soon(onMade) {
  let tries = 0;
  const go = () => wire().then((made) => {
    made.forEach(onMade);
    if (++tries < 16) setTimeout(go, 15000).unref();
  }).catch(() => {});
  setTimeout(go, 15000).unref();
}

module.exports = { wire, soon, MEDIA_IDS, LINKS };
