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
const fsp = require('fs/promises');
const path = require('path');
const state = require('./state-store');
const docker = require('./docker');
const { arrApiKey, addressOf, readEnv } = require('./insights');

const STATE_FILE = 'media-wired.json';
const MEDIA_IDS = new Set(['sonarr', 'radarr', 'prowlarr', 'qbittorrent', 'flaresolverr', 'bazarr', 'jellyfin', 'seerr']);

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

/**
 * The settings Podhouse's own box runs with, over the apps' defaults:
 * files renamed to the tidy format on import, a proper or repack never
 * re-downloading a file already there, and Sonarr importing an episode
 * whose title is not out yet instead of holding it. Applied to a fresh app
 * (empty library) once; one with a library is someone's and left alone.
 */
const ARR_SETTINGS = {
  radarr: { naming: { renameMovies: true }, mediamanagement: { downloadPropersAndRepacks: 'doNotUpgrade' } },
  sonarr: {
    naming: { renameEpisodes: true },
    mediamanagement: { downloadPropersAndRepacks: 'doNotUpgrade', episodeTitleRequired: 'never' },
  },
};

function arrSettings(arr) {
  return {
    id: `${arr}-settings`,
    needs: [arr],
    async run(env, prev) {
      const a = await app(arr, 'v3');
      const library = await api(a.base, a.key, 'GET', `/api/v3/${arr === 'radarr' ? 'movie' : 'series'}`);
      if (library.length && !prev) return 'library already in use';
      for (const [section, values] of Object.entries(ARR_SETTINGS[arr])) {
        const current = await api(a.base, a.key, 'GET', `/api/v3/config/${section}`);
        await api(a.base, a.key, 'PUT', `/api/v3/config/${section}`, { ...current, ...values });
      }
      return 'renaming on, propers and repacks not re-downloaded';
    },
  };
}

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

/**
 * A root folder full of films is still an empty Radarr: nothing is in its
 * library until each folder is added ("No movies found"). Add them, the way
 * Library Import does without the clicking.
 *
 * Only a folder the lookup matches with confidence — its own suggested
 * folder name, or the same title and year — is added; the rest stay for
 * Library Import rather than being guessed at. Nothing is searched for:
 * films come in unmonitored and series watch only FUTURE episodes, so an
 * imported library does not turn into a queue of upgrade downloads.
 *
 * An app that already has anything in its library is someone's library and
 * is left alone.
 */
function importLibrary(arr, envKey, fallback) {
  const kind = arr === 'radarr' ? 'movie' : 'series';
  const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  return {
    id: `${arr}-import`,
    needs: [arr],
    // The library root too: /data/tv is the same name inside the container
    // whether it is an empty local folder or a NAS full of series.
    stampExtra: (env) => `${env.HB_MEDIA_ROOT || ''}:${libraryPath(env, envKey, fallback)}`,
    async run(env, prev) {
      const a = await app(arr, 'v3');
      const have = await api(a.base, a.key, 'GET', `/api/v3/${kind}`);
      if (have.length && !prev) return 'library already in use';
      const path = libraryPath(env, envKey, fallback);
      const root = (await api(a.base, a.key, 'GET', '/api/v3/rootfolder'))
        .find((r) => r.path.replace(/\/+$/, '') === path);
      if (!root) throw new Error(`${path} is not a root folder yet`);
      const folders = root.unmappedFolders || [];
      if (!folders.length) return 'nothing to import';
      const profile = (await api(a.base, a.key, 'GET', '/api/v3/qualityprofile'))[0];

      let added = 0;
      for (const folder of folders) {
        const m = /^(.*?)(?:\s*\((\d{4})\))?$/.exec(folder.name);
        const title = norm(m[1]);
        const year = m[2] ? Number(m[2]) : null;
        const found = await api(a.base, a.key, 'GET', `/api/v3/${kind}/lookup?term=${encodeURIComponent(folder.name)}`)
          .catch(() => []);
        // Exactly one match, or none: "Cape Fear" with no year is three titles.
        const match = (list) => (list.length === 1 ? list[0] : null);
        const hit = match(found.filter((c) => c.folder && c.folder.toLowerCase() === folder.name.toLowerCase()))
          || match(found.filter((c) => norm(c.title) === title && (!year || c.year === year)));
        if (!hit) continue;
        const body = kind === 'movie'
          ? { ...hit, qualityProfileId: profile.id, rootFolderPath: path, path: folder.path,
            monitored: false, minimumAvailability: 'released', addOptions: { searchForMovie: false } }
          : { ...hit, qualityProfileId: profile.id, rootFolderPath: path, path: folder.path,
            monitored: true, seasonFolder: true,
            addOptions: { monitor: 'future', searchForMissingEpisodes: false, searchForCutoffUnmetEpisodes: false } };
        try {
          await api(a.base, a.key, 'POST', `/api/v3/${kind}`, body);
          added += 1;
        } catch { /* already there, or refused: leave it for Library Import */ }
      }
      return `imported ${added} of ${folders.length}`;
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
  // .env and qBittorrent can already disagree (a password changed in its own
  // web UI). If the NEW login is the one that opens it, the user is telling
  // Settings the real password: save it, change nothing in qBittorrent.
  const session = await qbitSession(oldEnv).catch(() => null);
  if (!session) {
    await qbitSession({ ...oldEnv, ...changes }).catch(() => {
      throw new Error('Neither the saved nor the new login opens qBittorrent. Type the password qBittorrent actually has.');
    });
    return;
  }
  await qbitSet(session, prefs);
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

/**
 * Bazarr reads Sonarr's and Radarr's libraries to know what needs subtitles.
 * Its own API key is in config.yaml (written on its first start); its
 * settings API takes form fields named settings-<section>-<key>.
 */
async function bazarrApp() {
  const yaml = await fsp.readFile(
    path.join(state.ROOT, 'modules', 'bazarr', 'config', 'bazarr', 'config', 'config.yaml'), 'utf8',
  ).catch(() => '');
  const key = /^auth:\n(?:[ \t]+.*\n)*?[ \t]+apikey:[ \t]*'?([A-Za-z0-9]+)/m.exec(yaml);
  if (!key) throw new Error('bazarr has not written its API key yet');
  return { base: await addressOf('bazarr'), key: key[1] };
}

function bazarrLink(arr, port) {
  return {
    id: `bazarr-${arr}`,
    needs: ['bazarr', arr],
    async run(env, prev) {
      const b = await bazarrApp();
      const target = await app(arr, 'v3');
      const headers = { 'x-api-key': b.key };
      const res = await fetch(`${b.base}/api/system/settings`, { headers, signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`bazarr settings answered ${res.status}`);
      const settings = await res.json();
      // First run on a Bazarr connected by hand: theirs, leave it.
      if (settings.general && settings.general[`use_${arr}`] && !prev) return 'already had one';
      const save = await fetch(`${b.base}/api/system/settings`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          [`settings-general-use_${arr}`]: 'true',
          [`settings-${arr}-ip`]: arr,
          [`settings-${arr}-port`]: String(port),
          [`settings-${arr}-base_url`]: '/',
          [`settings-${arr}-ssl`]: 'false',
          [`settings-${arr}-apikey`]: target.key,
        }),
        signal: AbortSignal.timeout(20000),
      });
      if (!save.ok) throw new Error(`bazarr refused the ${arr} settings (${save.status})`);
      return 'added';
    },
  };
}

/**
 * Without a languages profile Bazarr knows what is in the library and looks
 * for nothing ("Missing languages profile"). Seed one: Hebrew, with English
 * as the fallback — the cutoff is Hebrew, so English is fetched while Hebrew
 * is missing and the search stops once Hebrew is found. It becomes the
 * default for series and films Bazarr learns about from now on.
 *
 * Only on a Bazarr with no profile at all. Subtitle PROVIDERS are not
 * chosen here: like indexers, where subtitles come from is the user's call.
 */
const bazarrLanguages = {
  id: 'bazarr-languages',
  needs: ['bazarr'],
  async run() {
    const b = await bazarrApp();
    const headers = { 'x-api-key': b.key };
    const get = async (p) => {
      const res = await fetch(`${b.base}${p}`, { headers, signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`bazarr ${p} answered ${res.status}`);
      return res.json();
    };
    const profiles = await get('/api/system/languages/profiles');
    if (Array.isArray(profiles) && profiles.length) return 'already had one';

    const item = (id, language) => ({
      id, language, audio_exclude: 'False', hi: 'False', forced: 'False', audio_only_include: 'False',
    });
    const body = new URLSearchParams({
      'languages-profiles': JSON.stringify([{
        profileId: 1,
        name: 'Hebrew, then English',
        items: [item(1, 'he'), item(2, 'en')],
        cutoff: 1,
        mustContain: [],
        mustNotContain: [],
        originalFormat: false,
        tag: null,
      }]),
      'settings-general-serie_default_enabled': 'true',
      'settings-general-serie_default_profile': '1',
      'settings-general-movie_default_enabled': 'true',
      'settings-general-movie_default_profile': '1',
    });
    // languages-enabled REPLACES the enabled set, so send what is on already too.
    const languages = await get('/api/system/languages');
    const on = new Set((Array.isArray(languages) ? languages : []).filter((l) => l.enabled).map((l) => l.code2));
    for (const code of new Set([...on, 'he', 'en'])) body.append('languages-enabled', code);

    const res = await fetch(`${b.base}/api/system/settings`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`bazarr refused the languages profile (${res.status})`);
    return 'added Hebrew, then English';
  },
};

/* --------------------------------------------------------- Jellyfin, Seerr */

// Jellyfin 12 takes a token ONLY in this header: X-Emby-Token and ?api_key
// answer 401 now. Measured on 12.0.0.
const JF_CLIENT = 'MediaBrowser Client="Podhouse", Device="Podhouse", DeviceId="podhouse-dashboard", Version="1"';

async function jf(base, method, p, { token, body } = {}) {
  const res = await fetch(base + p, {
    method,
    headers: {
      authorization: token ? `${JF_CLIENT}, Token="${token}"` : JF_CLIENT,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`jellyfin ${method} ${p} answered ${res.status}`);
  return text ? JSON.parse(text) : null;
}

const jfLogin = (env) => ({ user: env.HB_JELLYFIN_USER || 'admin', pass: env.HB_JELLYFIN_PASS || '' });

async function jfSession(env) {
  const base = await addressOf('jellyfin');
  const { user, pass } = jfLogin(env);
  const auth = await jf(base, 'POST', '/Users/AuthenticateByName', { body: { Username: user, Pw: pass } })
    .catch(() => { throw new Error('the Jellyfin admin login in Settings does not open Jellyfin'); });
  return { base, token: auth.AccessToken, userId: auth.User && auth.User.Id };
}

/**
 * A fresh Jellyfin opens on a wizard that makes you invent an admin before
 * anything works, and every other app here needs that admin. Run the wizard
 * through its own API with the login from .env (Settings > Passwords).
 * A Jellyfin whose wizard was finished is someone's: left alone.
 */
const jellyfinSetup = {
  id: 'jellyfin-setup',
  needs: ['jellyfin'],
  async run(env) {
    const base = await addressOf('jellyfin');
    const info = await jf(base, 'GET', '/System/Info/Public');
    if (info.StartupWizardCompleted) return 'already set up';
    const { user, pass } = jfLogin(env);
    if (pass.length < 6) throw new Error('no Jellyfin admin password in .env yet');
    await jf(base, 'GET', '/Startup/User'); // makes the wizard's first user exist
    await jf(base, 'POST', '/Startup/User', { body: { Name: user, Password: pass } });
    await jf(base, 'POST', '/Startup/RemoteAccess', { body: { EnableRemoteAccess: true } });
    await jf(base, 'POST', '/Startup/Complete');
    return `created ${user}`;
  },
};

/**
 * Movies and TV libraries on the folders Radarr and Sonarr file into, so a
 * download shows up in Jellyfin with nobody pointing it anywhere. Follows
 * Configuration > Media like the root folders do; the path it added before is
 * swapped for the new one. A Jellyfin with libraries of its own the first
 * time this runs is left alone.
 */
const jellyfinLibraries = {
  id: 'jellyfin-libraries',
  needs: ['jellyfin'],
  stampExtra: (env) => [env.HB_MEDIA_ROOT || '', libraryPath(env, 'HB_MEDIA_MOVIES', 'media/movies'),
    libraryPath(env, 'HB_MEDIA_TV', 'media/tv')].join(':'),
  async run(env, prev) {
    const s = await jfSession(env);
    const have = await jf(s.base, 'GET', '/Library/VirtualFolders', { token: s.token });
    if (have.length && !prev) return 'already had libraries';
    const made = [];
    for (const [name, type, path] of [
      ['Movies', 'movies', libraryPath(env, 'HB_MEDIA_MOVIES', 'media/movies')],
      ['TV', 'tvshows', libraryPath(env, 'HB_MEDIA_TV', 'media/tv')],
    ]) {
      const lib = have.find((l) => l.Name === name);
      if (!lib) {
        const q = new URLSearchParams({ name, collectionType: type, paths: path, refreshLibrary: 'true' });
        await jf(s.base, 'POST', `/Library/VirtualFolders?${q}`, { token: s.token, body: { LibraryOptions: {} } });
        made.push(`${name} ${path}`);
        continue;
      }
      const locations = lib.Locations || [];
      if (locations.includes(path)) continue;
      await jf(s.base, 'POST', '/Library/VirtualFolders/Paths?refreshLibrary=true',
        { token: s.token, body: { Name: name, PathInfo: { Path: path } } });
      // Our old folder goes; one the user added stays.
      for (const old of locations.filter((l) => prev && String(prev.result || '').includes(l))) {
        await jf(s.base, 'DELETE', `/Library/VirtualFolders/Paths?${new URLSearchParams({ name, path: old, refreshLibrary: 'true' })}`,
          { token: s.token }).catch(() => {});
      }
      made.push(`${name} ${path}`);
    }
    return made.length ? `libraries ${made.join(', ')}` : 'libraries already right';
  },
};

/**
 * The Jellyfin login under Settings, applied to Jellyfin before it is saved
 * (the same order as qBittorrent's). Seerr signs people in through Jellyfin,
 * so it follows on its own.
 */
async function changeJellyfinLogin(oldEnv, changes) {
  const user = 'HB_JELLYFIN_USER' in changes;
  const pass = 'HB_JELLYFIN_PASS' in changes;
  if (!user && !pass) return;
  if (user && !String(changes.HB_JELLYFIN_USER).trim()) throw new Error('The Jellyfin username cannot be empty');
  if (pass && String(changes.HB_JELLYFIN_PASS).length < 6) throw new Error('The Jellyfin password needs at least 6 characters');
  const mine = (await docker.listContainers()).filter((c) => c.service === 'jellyfin');
  if (!mine.length) return;
  if (!mine.some((c) => c.rawState === 'running')) throw new Error('Start Jellyfin first, so the new login can be set in it');
  // A Jellyfin set up by hand has its own password, and .env a generated one
  // it never heard of. Typing the real one here is the fix, not a change.
  const s = await jfSession(oldEnv).catch(() => null);
  if (!s) {
    await jfSession({ ...oldEnv, ...changes }).catch(() => {
      throw new Error('Neither the saved nor the new login opens Jellyfin. Type the password Jellyfin actually has.');
    });
    return;
  }
  if (pass) {
    await jf(s.base, 'POST', `/Users/${s.userId}/Password`,
      { token: s.token, body: { CurrentPw: jfLogin(oldEnv).pass, NewPw: String(changes.HB_JELLYFIN_PASS) } });
  }
  if (user) {
    const me = await jf(s.base, 'GET', `/Users/${s.userId}`, { token: s.token });
    await jf(s.base, 'POST', `/Users/${s.userId}`, { token: s.token, body: { ...me, Name: String(changes.HB_JELLYFIN_USER).trim() } });
  }
}

async function seerrKey() {
  const file = path.join(state.ROOT, 'modules', 'seerr', 'config', 'seerr', 'settings.json');
  const json = JSON.parse(await fsp.readFile(file, 'utf8').catch(() => '{}'));
  if (!json.main || !json.main.apiKey) throw new Error('seerr has not written its settings yet');
  return json.main.apiKey;
}

async function sr(base, method, p, { key, cookie, body } = {}) {
  const res = await fetch(base + p, {
    method,
    headers: {
      ...(key ? { 'x-api-key': key } : {}),
      ...(cookie ? { cookie } : {}),
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`seerr ${method} ${p} answered ${res.status}: ${text.slice(0, 200)}`);
  return { data: text ? JSON.parse(text) : null, cookie: res.headers.get('set-cookie') };
}

/**
 * Seerr's wizard, done the way its first page does it: sign in with the
 * Jellyfin admin (which makes that account Seerr's administrator), sync
 * Jellyfin's libraries and switch them on, mark Seerr set up. Seerr v3 does
 * the library sync as its own POST and enables each library with a PUT.
 */
const seerrSetup = {
  id: 'seerr-setup',
  needs: ['seerr', 'jellyfin'],
  async run(env) {
    const base = await addressOf('seerr');
    const pub = (await sr(base, 'GET', '/api/v1/settings/public')).data;
    if (pub.initialized) return 'already set up';
    const { user, pass } = jfLogin(env);
    // Once Jellyfin is configured in Seerr (a run that stopped halfway),
    // naming the server again is refused — "Jellyfin hostname already
    // configured" — and a plain sign-in is what it takes.
    const server = pub.mediaServerType === 2 ? {}
      : { hostname: 'jellyfin', port: 8096, useSsl: false, urlBase: '', email: `${user}@podhouse.local`, serverType: 2 };
    const login = await sr(base, 'POST', '/api/v1/auth/jellyfin', { body: { username: user, password: pass, ...server } });
    const cookie = (/connect\.sid=[^;]+/.exec(login.cookie || '') || [])[0];
    if (!cookie) throw new Error('seerr did not open a session for the Jellyfin admin');
    // The library API changed between Seerr versions. 3.5: a POST to sync and
    // a PUT per library. 3.4: GET ?sync=true, then GET ?enable=<ids>.
    let libs;
    const sync = await sr(base, 'POST', '/api/v1/settings/jellyfin/library/sync', { cookie }).catch(() => null);
    if (sync) {
      libs = sync.data || [];
      for (const lib of libs) {
        await sr(base, 'PUT', `/api/v1/settings/jellyfin/library/${lib.id}`, { cookie, body: { enabled: true } });
      }
    } else {
      libs = (await sr(base, 'GET', '/api/v1/settings/jellyfin/library?sync=true', { cookie })).data || [];
      if (libs.length) {
        await sr(base, 'GET', `/api/v1/settings/jellyfin/library?enable=${libs.map((l) => l.id).join(',')}`, { cookie });
      }
    }
    await sr(base, 'POST', '/api/v1/settings/initialize', { cookie });
    return `signed in as ${user}, ${libs.length} libraries`;
  },
};

/**
 * Radarr and Sonarr as Seerr's request targets, so a request becomes a
 * download. Quality: "HD - 720p/1080p" where the app has it, else its first
 * profile; folder: the library folder this box files into.
 */
function seerrArr(arr, port) {
  const envKey = arr === 'radarr' ? 'HB_MEDIA_MOVIES' : 'HB_MEDIA_TV';
  const fallback = arr === 'radarr' ? 'media/movies' : 'media/tv';
  return {
    id: `seerr-${arr}`,
    needs: ['seerr', arr],
    stampExtra: (env) => libraryPath(env, envKey, fallback),
    async run(env, prev) {
      const base = await addressOf('seerr');
      if (!(await sr(base, 'GET', '/api/v1/settings/public')).data.initialized) throw new Error('seerr is not set up yet');
      const key = await seerrKey();
      const target = await app(arr, 'v3');
      const have = (await sr(base, 'GET', `/api/v1/settings/${arr}`, { key })).data || [];
      const old = have.find((s) => s.hostname === arr) || have[0];
      if (old && !prev) return 'already had one';
      const conn = { hostname: arr, port, apiKey: target.key, useSsl: false, baseUrl: '' };
      const test = (await sr(base, 'POST', `/api/v1/settings/${arr}/test`, { key, body: conn })).data;
      const profiles = test.profiles || [];
      const profile = profiles.find((p) => p.name === 'HD - 720p/1080p') || profiles[0];
      if (!profile) throw new Error(`${arr} has no quality profiles`);
      const body = {
        ...conn,
        name: arr === 'radarr' ? 'Radarr' : 'Sonarr',
        activeProfileId: profile.id,
        activeProfileName: profile.name,
        activeDirectory: libraryPath(env, envKey, fallback),
        is4k: false,
        isDefault: true,
        externalUrl: '',
        syncEnabled: false,
        preventSearch: false,
        ...(arr === 'radarr' ? { minimumAvailability: 'released' } : { enableSeasonFolders: true, seriesType: 'standard', animeSeriesType: 'anime' }),
      };
      if (old) {
        await sr(base, 'PUT', `/api/v1/settings/${arr}/${old.id}`, { key, body: { ...old, ...body } });
        return 'updated';
      }
      await sr(base, 'POST', `/api/v1/settings/${arr}`, { key, body });
      return `added (${profile.name})`;
    },
  };
}

const LINKS = [
  qbitPaths,
  // Before the import, so the settings are in place before the library is.
  arrSettings('sonarr'),
  arrSettings('radarr'),
  rootFolder('sonarr', 'HB_MEDIA_TV', 'media/tv'),
  rootFolder('radarr', 'HB_MEDIA_MOVIES', 'media/movies'),
  importLibrary('sonarr', 'HB_MEDIA_TV', 'media/tv'),
  importLibrary('radarr', 'HB_MEDIA_MOVIES', 'media/movies'),
  downloadClient('sonarr', { field: 'tvCategory', value: 'tv-sonarr' }),
  downloadClient('radarr', { field: 'movieCategory', value: 'radarr' }),
  prowlarrApp('sonarr', 'Sonarr'),
  prowlarrApp('radarr', 'Radarr'),
  flaresolverr,
  bazarrLink('sonarr', 8989),
  bazarrLink('radarr', 7878),
  bazarrLanguages,
  jellyfinSetup,
  jellyfinLibraries,
  seerrSetup,
  seerrArr('radarr', 7878),
  seerrArr('sonarr', 8989),
];

/**
 * Which installs of the apps a link was made between. A purged and reinstalled
 * Sonarr starts empty with a new API key — by the CLI or the dashboard alike —
 * so a changed key makes its links due again. A hash, not the keys themselves.
 */
// What identifies one install of each app: a purge and reinstall changes it.
// Without Seerr, Jellyfin and Bazarr here, a reinstalled Seerr kept the old
// "set up" record and was never set up again.
const IDENTITY = {
  sonarr: () => arrApiKey('sonarr'),
  radarr: () => arrApiKey('radarr'),
  prowlarr: () => arrApiKey('prowlarr'),
  bazarr: async () => (await bazarrApp()).key,
  seerr: seerrKey,
  jellyfin: async () => (await jf(await addressOf('jellyfin'), 'GET', '/System/Info/Public')).Id,
};

async function stampOf(link, env) {
  const keys = await Promise.all(link.needs.filter((n) => IDENTITY[n]).map((n) => IDENTITY[n]()));
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
      lastError.delete(link.id);
    } catch (err) {
      const prev = lastError.get(link.id);
      lastError.set(link.id, { message: err.message, count: prev && prev.message === err.message ? prev.count + 1 : 1 });
      console.log(`[media-wire] ${link.id} not yet: ${err.message}`);
    }
  }
  lastRun = Date.now();
  return made;
}

// Why each link that is not made yet is not, from the last pass. Memory only:
// it describes "now", and a restart starts a fresh pass anyway.
const lastError = new Map();
let lastRun = 0;

// What each link does, in the words the "Home Cinema" dialog
// shows. A link with no entry here is plumbing nobody needs to watch.
const LABELS = {
  'radarr-qbittorrent': 'Radarr sends downloads to qBittorrent',
  'sonarr-qbittorrent': 'Sonarr sends downloads to qBittorrent',
  'qbittorrent-paths': 'qBittorrent saves where Radarr and Sonarr look',
  'radarr-settings': 'Radarr renames films tidily',
  'sonarr-settings': 'Sonarr renames episodes tidily',
  'radarr-rootfolder': 'Radarr files films in the library',
  'sonarr-rootfolder': 'Sonarr files series in the library',
  'radarr-import': 'Films already there are added to Radarr',
  'sonarr-import': 'Series already there are added to Sonarr',
  'prowlarr-radarr': 'Prowlarr feeds its indexers to Radarr',
  'prowlarr-sonarr': 'Prowlarr feeds its indexers to Sonarr',
  'prowlarr-flaresolverr': 'Prowlarr can get past Cloudflare',
  'bazarr-radarr': 'Bazarr watches the films',
  'bazarr-sonarr': 'Bazarr watches the series',
  'bazarr-languages': 'Bazarr looks for Hebrew, then English',
  'jellyfin-setup': 'Jellyfin gets its admin account',
  'jellyfin-libraries': 'Jellyfin shows Movies and TV',
  'seerr-setup': 'Seerr signs in through Jellyfin',
  'seerr-radarr': 'Film requests go to Radarr',
  'seerr-sonarr': 'Series requests go to Sonarr',
};

/**
 * Every link whose apps are all installed, and where it stands: done,
 * waiting (an app still starting) or why it is not done yet. Asking also
 * nudges a pass, at most every 15 seconds, so the dialog moves on its own.
 */
async function status() {
  const containers = await docker.listContainers();
  const present = new Set(containers.map((c) => c.service));
  const done = await state.readJson(STATE_FILE, {});
  if (!running && Date.now() - lastRun > 15000) wire().catch(() => {});
  return LINKS
    .filter((l) => LABELS[l.id] && l.needs.every((n) => present.has(n)))
    .map((l) => {
      if (done[l.id]) return { id: l.id, needs: l.needs, label: LABELS[l.id], state: 'done', note: done[l.id].result };
      const err = lastError.get(l.id);
      // The same failure three passes running is not an app still starting.
      const stuck = err && err.count >= 3;
      return { id: l.id, needs: l.needs, label: LABELS[l.id], state: stuck ? 'stuck' : 'waiting', note: err ? plain(err.message) : null };
    });
}

// The failures someone can act on, in words; anything else as the app said it.
function plain(message) {
  if (/qBittorrent did not accept|downloadclient[\s\S]*(Authenticat|Unable to connect to qBittorrent)/i.test(message)) {
    return 'The qBittorrent login under Settings does not open qBittorrent';
  }
  if (/Jellyfin admin login in Settings/i.test(message)) return 'The Jellyfin login under Settings does not open Jellyfin';
  return message.split(/\r?\n/)[0].slice(0, 160);
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

module.exports = { wire, soon, status, changeQbitLogin, changeJellyfinLogin, MEDIA_IDS, LINKS };
