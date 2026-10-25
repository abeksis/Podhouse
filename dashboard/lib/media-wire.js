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
    // A new qBittorrent login under Settings makes the link due again.
    stampExtra: (env) => `${env.HB_QBIT_USER || 'admin'}:${env.HB_QBIT_PASS || ''}`,
    async run(env, prev) {
      const a = await app(arr, 'v3');
      const have = await api(a.base, a.key, 'GET', '/api/v3/downloadclient');
      const old = have.find((c) => c.implementation === 'QBittorrent');
      if (old && !prev) return 'already had one';
      if (old) {
        for (const f of old.fields) {
          if (f.name === 'username') f.value = env.HB_QBIT_USER || 'admin';
          if (f.name === 'password') f.value = env.HB_QBIT_PASS || '';
        }
        await api(a.base, a.key, 'PUT', `/api/v3/downloadclient/${old.id}`, old);
        return 'updated its qBittorrent login';
      }
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

const libraryPath = (env, envKey, fallback) => `/data/${(env[envKey] || fallback).replace(/^\/+|\/+$/g, '')}`;

function rootFolder(arr, envKey, fallback) {
  return {
    id: `${arr}-rootfolder`,
    needs: [arr],
    // The folder is part of the stamp: change it under Configuration > Media
    // (a NAS whose library says "Movies") and the link is due again.
    stampExtra: (env) => libraryPath(env, envKey, fallback),
    async run(env, prev) {
      const a = await app(arr, 'v3');
      const have = await api(a.base, a.key, 'GET', '/api/v3/rootfolder');
      const path = libraryPath(env, envKey, fallback);
      if (have.some((r) => r.path.replace(/\/+$/, '') === path)) return 'already had it';
      // First run on an app someone set up by hand: theirs, leave it.
      if (!prev && have.length) return 'left the existing root folder';
      await api(a.base, a.key, 'POST', '/api/v3/rootfolder', { path });
      // The one we added before goes only if it no longer exists (the library
      // moved to a NAS): otherwise it is a red "Missing root folder" forever.
      // One that still exists stays — films may be filed under it.
      const old = prev && /^added (\/.+)$/.exec(prev.result || '');
      const gone = old && have.find((r) => r.path.replace(/\/+$/, '') === old[1] && r.accessible === false);
      if (gone) await api(a.base, a.key, 'DELETE', `/api/v3/rootfolder/${gone.id}`).catch(() => {});
      return `added ${path}`;
    },
  };
}

// Prowlarr pushes indexers on its own schedule; after a link changes, push now.
const syncIndexers = (p) => api(p.base, p.key, 'POST', '/api/v1/command', { name: 'ApplicationIndexerSync' }).catch(() => {});

function prowlarrApp(arr, implementation) {
  return {
    id: `prowlarr-${arr}`,
    needs: ['prowlarr', arr],
    async run() {
      const p = await app('prowlarr', 'v1');
      const target = await app(arr, 'v3');
      const have = await api(p.base, p.key, 'GET', '/api/v1/applications');
      const old = have.find((x) => x.implementation === implementation);
      // First run on a box wired by hand: theirs, leave it.
      if (old && !prev) return 'already had one';
      if (old) {
        // Due again means Sonarr/Radarr was reinstalled with a new key, and the
        // old link would 401 forever. Prowlarr masks the stored key, so no compare.
        const field = old.fields.find((f) => f.name === 'apiKey');
        if (field) field.value = target.key;
        await api(p.base, p.key, 'PUT', `/api/v1/applications/${old.id}`, old);
        await syncIndexers(p);
        return 'refreshed its API key';
      }
      const body = await fromSchema(p, '/api/v1/applications', implementation, implementation, {
        prowlarrUrl: p.base,
        baseUrl: target.base,
        apiKey: target.key,
      });
      body.syncLevel = 'fullSync';
      await api(p.base, p.key, 'POST', '/api/v1/applications', body);
      await syncIndexers(p);
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

async function qbitSession(env) {
  const base = await addressOf('qbittorrent');
  const login = await fetch(`${base}/api/v2/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', referer: base },
    body: new URLSearchParams({ username: env.HB_QBIT_USER || 'admin', password: env.HB_QBIT_PASS || '' }),
    signal: AbortSignal.timeout(20000),
  });
  // "SID" before qBittorrent 5.2, "QBT_SID_<port>" since.
  const sid = /\b(?:QBT_)?SID\w*=[^;]+/.exec(login.headers.get('set-cookie') || '');
  if (!sid) throw new Error(`qBittorrent did not accept the saved login (${login.status})`);
  return { base, headers: { cookie: sid[0], referer: base } };
}

async function qbitSet({ base, headers }, prefs) {
  const res = await fetch(`${base}/api/v2/app/setPreferences`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ json: JSON.stringify(prefs) }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`qBittorrent refused the change (${res.status})`);
}

/**
 * The qBittorrent login under Settings is only .env until qBittorrent is told.
 * Called BEFORE the new values are saved, while the old ones still open it.
 * Not installed: nothing to tell. Installed but stopped: refuse, or .env and
 * qBittorrent would disagree and Sonarr/Radarr would lose their downloads.
 */
async function changeQbitLogin(oldEnv, changes) {
  const user = 'HB_QBIT_USER' in changes;
  const pass = 'HB_QBIT_PASS' in changes;
  if (!user && !pass) return;
  if (user && !String(changes.HB_QBIT_USER).trim()) throw new Error('The qBittorrent username cannot be empty');
  // qBittorrent itself rejects shorter ones.
  if (pass && String(changes.HB_QBIT_PASS).length < 6) throw new Error('The qBittorrent password needs at least 6 characters');
  const mine = (await docker.listContainers()).filter((c) => c.service === 'qbittorrent');
  if (!mine.length) return;
  if (!mine.some((c) => c.rawState === 'running')) throw new Error('Start qBittorrent first, so the new login can be set in it');
  const prefs = {};
  if (user) prefs.web_ui_username = String(changes.HB_QBIT_USER).trim();
  if (pass) prefs.web_ui_password = String(changes.HB_QBIT_PASS);
  await qbitSet(await qbitSession(oldEnv), prefs);
}

/**
 * qBittorrent ships saving into /config/Downloads, which no other app can see:
 * Sonarr/Radarr then report "directory does not appear to exist" and nothing
 * is imported. Point it at the shared pool, where an import is a hardlink.
 * Only while it is still on that default — a path the user chose stays.
 */
const qbitPaths = {
  id: 'qbittorrent-paths',
  needs: ['qbittorrent'],
  // Downloads renamed under Configuration > Media (a NAS that says "torrents"):
  // due again, and the path this set before moves with it.
  stampExtra: (env) => libraryPath(env, 'HB_DOWNLOADS', 'downloads'),
  async run(env, prev) {
    const { base, headers } = await qbitSession(env);
    const prefs = await (await fetch(`${base}/api/v2/app/preferences`, { headers })).json();
    const dl = libraryPath(env, 'HB_DOWNLOADS', 'downloads');
    const ours = prev && /^save path (\/.+)$/.exec(prev.result || '');
    const current = String(prefs.save_path).replace(/\/+$/, '');
    if (current === dl) return `save path ${dl}`;
    if (!current.startsWith('/config') && !(ours && ours[1] === current)) return `left ${current}`;
    await qbitSet({ base, headers }, { save_path: dl, temp_path: `${dl}/incomplete`, temp_path_enabled: true });
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
async function stampOf(link, env) {
  const keys = await Promise.all(link.needs.filter((n) => ['sonarr', 'radarr', 'prowlarr'].includes(n)).map(arrApiKey));
  if (link.stampExtra) keys.push(link.stampExtra(env));
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
      const stamp = await stampOf(link, env);
      if (done[link.id] && done[link.id].stamp === stamp) continue;
      const result = await link.run(env, done[link.id]);
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

module.exports = { wire, soon, changeQbitLogin, MEDIA_IDS, LINKS };
