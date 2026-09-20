'use strict';
/**
 * Putting a backup back, from the browser.
 *
 * `homebox restore` unpacks an archive into a new directory and touches
 * nothing — deliberately, because a restore WRITES OVER a running box, and
 * that is the one operation here that can destroy data rather than create it.
 * This does the same job through the page without giving that property away:
 *
 *   1. The archive arrives (uploaded, or one already on this box or its NAS
 *      copy) and is decrypted and authenticated in full before anything else.
 *      A file that is not a Podhouse backup, or whose key does not match,
 *      stops here.
 *   2. It is unpacked to a staging directory that is nowhere near the live
 *      tree, and READ: which apps are in it, how many files and bytes each
 *      holds, whether that app exists on this box now, and what would be
 *      written over.
 *   3. Nothing moves until the choice is made and confirmed — per app, plus
 *      `.env` and Podhouse's own state as separate opt-ins. There is no
 *      "restore everything" button, because there is no moment where one
 *      click should be able to replace a live database.
 *   4. Applying takes a fresh backup FIRST, stops only the apps it is about
 *      to rewrite, moves what it replaces aside (so it can be put back by
 *      hand), copies, restores ownership, and starts them again.
 *
 * `data/` — the media pool — is never restored from here. It is the one part
 * that is measured in terabytes, it is not configuration, and a copy that
 * takes an hour is not something a web request should be holding open.
 *
 * The decrypted copy is the whole box in the clear. It is written 0600 into a
 * 0700 directory, and deleted when the restore finishes or is discarded.
 */

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');

const state = require('./state-store');
const backup = require('./backup');
const composeLib = require('./compose');

const ROOT = state.ROOT;
const STAGE_DIR = path.join(state.STATE_DIR, 'restore');

// An upload bigger than this is not a config backup; it is a mistake or an
// attempt to fill the disk. A `full` archive of a media pool belongs on the
// shell path, where nothing is holding an HTTP request open for an hour.
const MAX_UPLOAD = 8 * 1024 * 1024 * 1024;

// What a restore is allowed to write, and nothing else. Checked against every
// entry in the archive before it is unpacked and again before it is copied.
const MODULE_CONFIG = /^modules\/([a-z0-9][a-z0-9-]{0,39})\/config(\/|$)/;
const STATE_ENTRY = /^state(\/|$)/;
const ENV_ENTRY = /^\.env$/;

class RestoreError extends Error {
  constructor(message, hint) {
    super(message);
    this.name = 'RestoreError';
    this.hint = hint || null;
  }
}

const id16 = () => crypto.randomBytes(8).toString('hex');
const stagePath = (id, ...rest) => {
  if (!/^[a-f0-9]{16}$/.test(String(id))) throw new RestoreError('not a restore id');
  return path.join(STAGE_DIR, String(id), ...rest);
};

async function ensureStage(id) {
  await fsp.mkdir(STAGE_DIR, { recursive: true, mode: 0o700 });
  await fsp.chmod(STAGE_DIR, 0o700).catch(() => {});
  const dir = stagePath(id);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** argv only, never a shell string: archive names reach a real process. */
function run(command, args, { cwd = ROOT, timeout = 30 * 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd });
    let stderr = '';
    let stdout = '';
    child.stdout.on('data', (c) => { stdout = (stdout + c).slice(-4 * 1024 * 1024); });
    child.stderr.on('data', (c) => { stderr = (stderr + c).slice(-8000); });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new RestoreError(`${command} took too long`)); }, timeout);
    timer.unref();
    child.on('error', (err) => { clearTimeout(timer); reject(new RestoreError(`${command}: ${err.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      // tar exits 1 for "file changed as we read it" and similar warnings.
      if (code === 0 || code === 1) resolve({ stdout, stderr });
      else reject(new RestoreError(`${command} exited ${code}`, stderr.trim().slice(0, 300) || null));
    });
  });
}

/* ------------------------------------------------------------- receiving */

/**
 * An upload, straight to disk. Not through readBody: that caps at 16KB for
 * good reasons, and an archive is hundreds of megabytes.
 */
function receive(req, id) {
  return new Promise((resolve, reject) => {
    ensureStage(id).then((dir) => {
      const file = path.join(dir, 'archive.enc');
      const out = fs.createWriteStream(file, { mode: 0o600 });
      let size = 0;
      let stopped = false;
      const fail = (message) => {
        if (stopped) return;
        stopped = true;
        out.destroy();
        req.destroy();
        fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
        reject(new RestoreError(message));
      };
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_UPLOAD) fail('that file is larger than a settings backup can be');
      });
      req.on('error', () => fail('the upload did not finish'));
      out.on('error', (err) => fail(`could not write the upload: ${err.message}`));
      out.on('close', () => {
        if (stopped) return;
        if (!size) { fail('nothing was uploaded'); return; }
        resolve({ id, size });
      });
      req.pipe(out);
    }).catch(reject);
  });
}

/** An archive already on this box: in backups/, or in the NAS copy folder. */
async function fromExisting(name) {
  const local = backup.resolveName(name);              // validates the filename
  const copy = (await backup.copyStatus()).dir;
  const candidates = [local, copy ? path.join(copy, name) : null].filter(Boolean);
  for (const file of candidates) {
    try {
      await fsp.access(file, fs.constants.R_OK);
      const id = id16();
      const dir = await ensureStage(id);
      // Copied rather than linked: the original must stay exactly as it is,
      // and the NAS may be gone by the time the restore runs.
      await fsp.copyFile(file, path.join(dir, 'archive.enc'));
      await fsp.chmod(path.join(dir, 'archive.enc'), 0o600).catch(() => {});
      return { id, size: (await fsp.stat(file)).size, from: file };
    } catch { /* try the next place */ }
  }
  throw new RestoreError(`${name} is not on this box or on the copy folder`);
}

/* -------------------------------------------------------------- reading */

/**
 * Decrypt, unpack and describe. Nothing here writes outside the staging
 * directory, and the decrypted archive never leaves it.
 */
async function inspect(id) {
  const dir = stagePath(id);
  const enc = path.join(dir, 'archive.enc');
  const plain = path.join(dir, 'archive.tar.gz');
  const tree = path.join(dir, 'tree');

  const secret = backup.requireSecret();
  if (!fs.existsSync(plain)) {
    // decryptFile authenticates the whole file and deletes its own output if
    // the tag does not match — a wrong key or a damaged archive stops here,
    // before anything has been unpacked.
    try {
      await backup.decryptFile(enc, plain, secret);
    } catch {
      throw new RestoreError(
        'that file could not be opened with this box\'s backup key',
        'It is either not a Podhouse backup, or it was made with a different HB_BACKUP_KEY. Settings → Backups shows the key this box uses.',
      );
    }
    await fsp.chmod(plain, 0o600).catch(() => {});
  }

  // Run inside the staging directory with relative names: a path that
  // starts with a drive letter reads as 'host:path' to GNU tar, and one with
  // spaces or a colon anywhere is an argument nobody should have to think
  // about. Nothing here needs the absolute form.
  const { stdout } = await run('tar', ['-tzf', 'archive.tar.gz'], { cwd: dir });
  const entries = stdout.split('\n').map((l) => l.trim().replace(/^\.\//, '')).filter(Boolean);
  if (!entries.length) throw new RestoreError('that archive is empty');

  // Nothing outside the tree, ever. An archive is a file from somewhere else;
  // an absolute path or a `..` in it is how a restore writes to /etc.
  const escaping = entries.find((e) => path.isAbsolute(e) || e.split('/').includes('..'));
  if (escaping) throw new RestoreError(`that archive contains a path outside the box: ${escaping}`);

  if (!fs.existsSync(tree)) {
    await fsp.mkdir(tree, { recursive: true, mode: 0o700 });
    // Everything except the media pool, which is never restored from here.
    await run('tar', ['-xzf', 'archive.tar.gz', '-C', 'tree', '--exclude=data', '--exclude=./data'], { cwd: dir });
  }

  const modules = new Map();
  let stateFiles = 0;
  let stateBytes = 0;
  let hasEnv = false;
  let dataEntries = 0;

  for (const entry of entries) {
    const mod = MODULE_CONFIG.exec(entry);
    if (mod) {
      const row = modules.get(mod[1]) || { id: mod[1], files: 0, bytes: 0 };
      const size = await sizeIn(tree, entry);
      if (size != null) { row.files += 1; row.bytes += size; }
      modules.set(mod[1], row);
      continue;
    }
    if (ENV_ENTRY.test(entry)) { hasEnv = true; continue; }
    if (STATE_ENTRY.test(entry)) {
      const size = await sizeIn(tree, entry);
      if (size != null) { stateFiles += 1; stateBytes += size; }
      continue;
    }
    if (/^\.?\/?data(\/|$)/.test(entry)) dataEntries += 1;
  }

  // What each app looks like on the box right now, so the page can say
  // "replaces 214 files" rather than "restores something".
  const apps = [];
  for (const row of [...modules.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    const livePath = path.join(ROOT, 'modules', row.id, 'config');
    const live = await measure(livePath);
    apps.push({
      ...row,
      installed: fs.existsSync(path.join(ROOT, 'modules', row.id, 'docker-compose.yml')),
      liveFiles: live.files,
      liveBytes: live.bytes,
      liveNewestAt: live.newest,
      // The honest word for what pressing the button does to this app.
      effect: live.files ? 'replace' : 'add',
    });
  }

  const meta = await readMeta(id);
  const info = {
    id,
    createdAt: meta.createdAt || null,
    source: meta.source || null,
    fileName: meta.fileName || null,
    apps,
    env: hasEnv ? { present: true, liveExists: fs.existsSync(path.join(ROOT, '.env')) } : { present: false },
    state: { files: stateFiles, bytes: stateBytes, present: stateFiles > 0 },
    skippedData: dataEntries,
  };
  await writeMeta(id, { ...meta, inspectedAt: Date.now() });
  return info;
}

async function sizeIn(tree, entry) {
  try {
    const st = await fsp.lstat(path.join(tree, entry));
    return st.isFile() ? st.size : null;
  } catch {
    return null;                                    // a directory entry, or excluded
  }
}

/** Files, bytes and the newest timestamp under a live directory. */
async function measure(dir) {
  let files = 0;
  let bytes = 0;
  let newest = 0;
  const walk = async (current) => {
    let entries = [];
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) { await walk(full); continue; }
      try {
        const st = await fsp.lstat(full);
        files += 1;
        bytes += st.size;
        newest = Math.max(newest, st.mtimeMs);
      } catch { /* vanished */ }
    }
  };
  await walk(dir);
  return { files, bytes, newest: newest || null };
}

const metaFile = (id) => stagePath(id, 'meta.json');

async function readMeta(id) {
  try {
    return JSON.parse(await fsp.readFile(metaFile(id), 'utf8'));
  } catch {
    return {};
  }
}

async function writeMeta(id, meta) {
  await fsp.writeFile(metaFile(id), JSON.stringify(meta, null, 2), { mode: 0o600 });
}

/* -------------------------------------------------------------- applying */

/**
 * Ownership, after copying as root.
 *
 * The dashboard runs as root inside its container and the tree belongs to the
 * box's own account. Files copied without this are root-owned, and the app —
 * which drops privileges — then cannot write its own database.
 */
async function matchOwner(target) {
  let owner;
  try {
    owner = await fsp.stat(ROOT);
  } catch {
    return;
  }
  const apply = async (p) => {
    await fsp.lchown(p, owner.uid, owner.gid).catch(() => {});
    let entries = [];
    try {
      entries = await fsp.readdir(p, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) await apply(path.join(p, entry.name));
  };
  await apply(target);
}

/**
 * Do it.
 *
 * `choice` is what the person ticked: { apps: [ids], env: bool, state: bool }.
 * Every step reports a line, because this is the operation where silence is
 * frightening and the order of events is the thing you want to see.
 */
async function apply(id, choice, onLine = null) {
  const say = (line) => { if (onLine) onLine(line, false); };
  const dir = stagePath(id);
  const tree = path.join(dir, 'tree');
  if (!fs.existsSync(tree)) throw new RestoreError('this restore has not been read yet');

  const plan = await inspect(id);
  const wanted = new Set(Array.isArray(choice.apps) ? choice.apps : []);
  const apps = plan.apps.filter((a) => wanted.has(a.id));
  const withEnv = choice.env === true && plan.env.present;
  const withState = choice.state === true && plan.state.present;
  if (!apps.length && !withEnv && !withState) throw new RestoreError('nothing was chosen to restore');

  const replaced = path.join(dir, 'replaced');
  await fsp.mkdir(replaced, { recursive: true, mode: 0o700 });
  const done = { apps: [], env: false, state: false, backup: null, restarted: [], failed: [] };

  // A backup of the box as it is now, BEFORE anything is written over. If the
  // archive turns out to be the wrong one, this is the way back.
  say('Backing up the current settings first');
  try {
    const made = await backup.create({ kind: 'config' });
    done.backup = made.name;
    say(`  saved ${made.name}`);
  } catch (err) {
    throw new RestoreError(`could not take a backup before restoring: ${err.message}`,
      'Nothing was changed. Fix the backup problem first — that safety net is the point.');
  }

  for (const app of apps) {
    const live = path.join(ROOT, 'modules', app.id, 'config');
    const from = path.join(tree, 'modules', app.id, 'config');
    if (!fs.existsSync(from)) { say(`  ${app.id}: nothing in the archive, skipped`); continue; }

    // Stopped first: an app writing to its database while its files are
    // swapped underneath it corrupts both copies.
    let wasRunning = false;
    try {
      say(`${app.id}: stopping`);
      await composeLib.stop(app.id);
      wasRunning = true;
    } catch {
      say(`  ${app.id}: not running`);
    }

    try {
      if (fs.existsSync(live)) {
        const aside = path.join(replaced, `${app.id}-config`);
        await fsp.rm(aside, { recursive: true, force: true });
        await fsp.rename(live, aside);
        say(`  ${app.id}: current settings moved aside`);
      }
      await fsp.cp(from, live, { recursive: true, force: true, preserveTimestamps: true });
      await matchOwner(live);
      say(`  ${app.id}: restored ${app.files} file${app.files === 1 ? '' : 's'}`);
      done.apps.push(app.id);
    } catch (err) {
      say(`  ${app.id}: FAILED — ${err.message}`);
      done.failed.push({ id: app.id, error: err.message });
    }

    if (wasRunning) {
      try {
        await composeLib.start(app.id);
        say(`  ${app.id}: started again`);
        done.restarted.push(app.id);
      } catch (err) {
        say(`  ${app.id}: could not start again — ${err.message}`);
        done.failed.push({ id: app.id, error: err.message });
      }
    }
  }

  if (withEnv) {
    const from = path.join(tree, '.env');
    const live = path.join(ROOT, '.env');
    try {
      if (fs.existsSync(live)) await fsp.copyFile(live, path.join(replaced, 'env'));
      await fsp.copyFile(from, live);
      await fsp.chmod(live, 0o600).catch(() => {});
      await matchOwner(live);
      done.env = true;
      say('Settings and secrets (.env) restored — apps keep their current values until they are recreated');
    } catch (err) {
      say(`.env: FAILED — ${err.message}`);
      done.failed.push({ id: '.env', error: err.message });
    }
  }

  if (withState) {
    const from = path.join(tree, 'state');
    try {
      const keep = new Set(['restore']);            // never overwrite this run
      for (const entry of await fsp.readdir(from, { withFileTypes: true })) {
        if (keep.has(entry.name)) continue;
        const target = path.join(state.STATE_DIR, entry.name);
        if (fs.existsSync(target)) {
          await fsp.rm(path.join(replaced, `state-${entry.name}`), { recursive: true, force: true });
          await fsp.rename(target, path.join(replaced, `state-${entry.name}`));
        }
        await fsp.cp(path.join(from, entry.name), target, { recursive: true, force: true });
      }
      await matchOwner(state.STATE_DIR);
      done.state = true;
      say('Podhouse\'s own state restored — including the login from the backup');
    } catch (err) {
      say(`state: FAILED — ${err.message}`);
      done.failed.push({ id: 'state', error: err.message });
    }
  }

  // The decrypted copy is every password on the box in the clear. It goes now;
  // what was replaced stays until the restore is discarded, as the way back.
  await fsp.rm(path.join(dir, 'archive.tar.gz'), { force: true }).catch(() => {});
  await fsp.rm(tree, { recursive: true, force: true }).catch(() => {});
  await writeMeta(id, { ...(await readMeta(id)), appliedAt: Date.now(), done });
  say('Done');
  return done;
}

/** Everything staged, so a reload can pick the thread back up. */
async function list() {
  let ids = [];
  try {
    ids = (await fsp.readdir(STAGE_DIR, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && /^[a-f0-9]{16}$/.test(e.name))
      .map((e) => e.name);
  } catch {
    return [];
  }
  const out = [];
  for (const id of ids) {
    const meta = await readMeta(id);
    let size = null;
    try { size = (await fsp.stat(stagePath(id, 'archive.enc'))).size; } catch { /* mid-delete */ }
    out.push({ id, size, ...meta });
  }
  return out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

async function discard(id) {
  await fsp.rm(stagePath(id), { recursive: true, force: true });
  return { ok: true, id };
}

module.exports = {
  receive, fromExisting, inspect, apply, list, discard, writeMeta, readMeta, matchOwner,
  RestoreError, MAX_UPLOAD, id16,
};
