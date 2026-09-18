'use strict';
/**
 * Backup Center.
 *
 * An archive here contains `.env` — every generated password on the box — so
 * it is encrypted, always. There is no "unencrypted for convenience" path: if
 * the key is missing the operation fails and says how to create one, rather
 * than quietly writing the box's secrets to a file someone might copy to a
 * NAS.
 *
 * Format:
 *
 *     [ 16-byte IV ][ AES-256-GCM ciphertext ][ 16-byte auth tag ]
 *
 * The key is scrypt-derived from HB_BACKUP_KEY. GCM only yields its tag after
 * final(), which is why the tag is a footer rather than a header — that lets
 * the ciphertext stream straight to disk instead of buffering the whole
 * archive in memory.
 */

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const { pipeline } = require('stream/promises');

const state = require('./state-store');
const modulesLib = require('./modules');

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const SALT = 'homebox-backup-salt';

const ROOT = state.ROOT;
const BACKUP_DIR = path.join(ROOT, 'backups');
const ENV_FILE = path.join(ROOT, '.env');
const SCHEDULE_FILE = 'backup-schedule.json';

// homebox-<kind>-YYYYMMDD_HHMMSS.tar.gz.enc
const NAME_RE = /^homebox-(config|full)-\d{8}_\d{6}\.tar\.gz\.enc$/;

const DEFAULT_SCHEDULE = { enabled: false, preset: 'daily', retention: 7, lastRun: null };
const PRESETS = {
  daily: { label: 'Every day at 02:00', everyMs: 24 * 3600e3 },
  weekly: { label: 'Every Sunday at 02:00', everyMs: 7 * 24 * 3600e3 },
  monthly: { label: 'On the 1st at 02:00', everyMs: 30 * 24 * 3600e3 },
};

class BackupError extends Error {
  constructor(message, hint) {
    super(message);
    this.name = 'BackupError';
    this.hint = hint || null;
  }
}

/* ------------------------------------------------------------------ keys */

/**
 * Read one value out of .env without pulling the rest of the file into memory
 * as a parsed object — nothing here has any business with the other values.
 *
 * Read from the file rather than the environment on purpose: the CLI runs this
 * module on the host, where the container's environment does not exist, and
 * the file is the one place both sides agree on.
 */
function readEnvValue(key) {
  try {
    const prefix = `${key}=`;
    for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.startsWith(prefix)) return trimmed.slice(prefix.length).replace(/^["']|["']$/g, '').trim() || null;
    }
  } catch {
    /* no .env: treated the same as the value not being set */
  }
  return null;
}

const readKeyFromEnv = () => readEnvValue('HB_BACKUP_KEY');

function requireSecret() {
  const secret = readKeyFromEnv();
  if (!secret) {
    throw new BackupError(
      'No backup encryption key is set',
      'Add HB_BACKUP_KEY to /opt/podhouse/.env (or re-run install.sh, which generates one) and restart the dashboard.'
    );
  }
  return secret;
}

const deriveKey = (secret) => crypto.scryptSync(secret, SALT, KEY_LENGTH);

/* ------------------------------------------------------------- utilities */

function timestamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}`
    + `_${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

/** argv only, never a shell string — filenames here reach a real process. */
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    let stderr = '';
    if (child.stderr) child.stderr.on('data', (c) => { stderr = (stderr + c).slice(-8000); });
    child.on('error', (err) => reject(new BackupError(`${command}: ${err.message}`)));
    child.on('close', (code) => (code === 0
      ? resolve()
      : reject(new BackupError(`${command} exited ${code}`, stderr.trim().slice(0, 400) || null))));
  });
}

async function ensureDir() {
  await fsp.mkdir(BACKUP_DIR, { recursive: true, mode: 0o700 });
  // Also for a directory an older version already created world-readable. The
  // archives inside hold .env and state/, so the directory is as sensitive as
  // they are.
  await fsp.chmod(BACKUP_DIR, 0o700).catch(() => {});
  // Created from inside the container it is root's, and the box's own account
  // then cannot list the backups it is told to copy somewhere safe.
  await matchOwner(BACKUP_DIR);
}

/**
 * A private path nobody else can guess or collide with.
 *
 * `.staging-${pid}` is neither: two backups in one process reuse it, and any
 * local account knows the name before it exists. The random half makes the
 * name unpredictable, and the caller opens it 0600.
 */
function scratchPath(dir, prefix) {
  return path.join(dir, `${prefix}-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
}

/* ------------------------------------------------------------ encryption */

async function encryptFile(plainPath, encPath, secret) {
  const key = deriveKey(secret);
  const iv = crypto.randomBytes(IV_LENGTH);
  const tmp = scratchPath(path.dirname(encPath), '.enc');

  await fsp.writeFile(tmp, iv, { mode: 0o600 });
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  await pipeline(fs.createReadStream(plainPath), cipher, fs.createWriteStream(tmp, { flags: 'a' }));
  await fsp.appendFile(tmp, cipher.getAuthTag());

  // Read it back and authenticate before it is allowed to become a real
  // backup. An archive that cannot be decrypted is worse than no archive:
  // it is an archive you believe in.
  try {
    await decryptToSink(tmp, key);
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    throw err;
  }
  await fsp.rename(tmp, encPath);
}

/** Decrypt into nothing, purely to make GCM verify the tag. */
async function decryptToSink(encPath, key) {
  const { size } = await fsp.stat(encPath);
  if (size < IV_LENGTH + TAG_LENGTH) throw new BackupError('archive is too short to be valid');

  const handle = await fsp.open(encPath, 'r');
  try {
    const iv = Buffer.alloc(IV_LENGTH);
    await handle.read(iv, 0, IV_LENGTH, 0);
    const tag = Buffer.alloc(TAG_LENGTH);
    await handle.read(tag, 0, TAG_LENGTH, size - TAG_LENGTH);

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    const body = fs.createReadStream(encPath, { start: IV_LENGTH, end: size - TAG_LENGTH - 1 });
    const sink = new (require('stream').Writable)({ write(_c, _e, cb) { cb(); } });
    await pipeline(body, decipher, sink);
  } finally {
    await handle.close();
  }
}

/** Decrypt to a real file, for restore. */
async function decryptFile(encPath, outPath, secret) {
  const key = deriveKey(secret);
  const { size } = await fsp.stat(encPath);
  const handle = await fsp.open(encPath, 'r');
  try {
    const iv = Buffer.alloc(IV_LENGTH);
    await handle.read(iv, 0, IV_LENGTH, 0);
    const tag = Buffer.alloc(TAG_LENGTH);
    await handle.read(tag, 0, TAG_LENGTH, size - TAG_LENGTH);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    try {
      await pipeline(
        fs.createReadStream(encPath, { start: IV_LENGTH, end: size - TAG_LENGTH - 1 }),
        decipher,
        // 0600: this is the decrypted copy of everything on the box, and it
        // sits on disk for as long as the restore takes.
        fs.createWriteStream(outPath, { mode: 0o600 })
      );
    } catch (err) {
      // GCM only fails at the END, after the plaintext has been written. A
      // failed authentication must not leave a readable copy behind of an
      // archive we just decided not to trust.
      await fsp.rm(outPath, { force: true });
      throw err;
    }
  } finally {
    await handle.close();
  }
}

/* ---------------------------------------------------------------- create */

/**
 * What goes in.
 *
 * `config` is the useful one: every app's settings and database, the enabled
 * list, and .env. It is small enough to keep many of and fast enough to run
 * nightly.
 *
 * `full` adds the data pool. On a box with a media library that is hundreds
 * of gigabytes, which is why it is not the default and not what the schedule
 * runs.
 */
function tarArgs(kind, excludes = []) {
  const args = ['-czf', '-', '-C', ROOT];
  const modules = fs.existsSync(path.join(ROOT, 'modules')) ? ['modules'] : [];
  const parts = [...modules, 'state'];
  if (fs.existsSync(ENV_FILE)) parts.push('.env');
  if (kind === 'full' && fs.existsSync(path.join(ROOT, 'data'))) parts.push('data');
  // Never fold the backup directory into a backup.
  //
  // Note the bare `backups`: BusyBox tar matches a slash-less pattern against
  // every path component, so this also skips any directory named "backups"
  // inside a module's config — an app's own backup folder. That is left as it
  // is on purpose (a backup of backups is the fastest way to fill a disk), but
  // it is a rule, not an accident, and changing it is a size decision.
  args.push('--exclude=./backups', '--exclude=backups');
  // What each module declares it rebuilds by itself. Full relative paths only;
  // see backupExcludes() in lib/modules.js for why.
  for (const p of excludes) args.push(`--exclude=${p}`);
  return args.concat(parts);
}

let inFlight = false;

/** Every module's declared rebuildable paths, as paths relative to ROOT. */
async function rebuildableExcludes() {
  try {
    const { modules } = await modulesLib.loadAll();
    return modules.flatMap((m) => (Array.isArray(m.backup_exclude) ? m.backup_exclude : [])
      .map((p) => `modules/${path.basename(m.dir)}/config/${p}`));
  } catch {
    return [];
  }
}

async function create({ kind = 'config' } = {}) {
  if (!['config', 'full'].includes(kind)) throw new BackupError(`unknown backup kind: ${kind}`);
  if (inFlight) throw new BackupError('a backup is already running');
  const secret = requireSecret();

  inFlight = true;
  const started = Date.now();
  await ensureDir();
  const name = `homebox-${kind}-${timestamp()}.tar.gz.enc`;
  const target = path.join(BACKUP_DIR, name);
  const plain = scratchPath(BACKUP_DIR, '.staging') + '.tar.gz';

  try {
    // tar to a staging file rather than piping into the cipher: a tar that
    // fails halfway would otherwise produce a perfectly decryptable archive
    // of half a box.
    const excludes = await rebuildableExcludes();
    await new Promise((resolve, reject) => {
      const child = spawn('tar', tarArgs(kind, excludes), { cwd: ROOT });
      // 0600 from the first byte: this is the whole box in the clear until
      // the cipher has run over it.
      const out = fs.createWriteStream(plain, { mode: 0o600 });
      let stderr = '';
      child.stderr.on('data', (c) => { stderr = (stderr + c).slice(-8000); });
      child.stdout.pipe(out);
      child.on('error', reject);
      child.on('close', (code) => {
        out.end();
        // tar exits 1 for "file changed as we read it", which is normal on a
        // live box and does not invalidate the archive. Only 2+ is fatal.
        if (code === 0 || code === 1) resolve();
        else reject(new BackupError(`tar exited ${code}`, stderr.trim().slice(0, 400)));
      });
    });

    await encryptFile(plain, target, secret);
    await matchOwner(target);
    const { size } = await fsp.stat(target);
    await prune();
    // After the local archive is final and verified, never instead of it: a
    // NAS that is down must not cost the box the backup it did manage.
    const copy = await copyOffBox(name, secret);
    return { name, size, kind, copy, seconds: Math.round((Date.now() - started) / 1000) };
  } finally {
    await fsp.rm(plain, { force: true });
    inFlight = false;
  }
}

/**
 * The dashboard runs as root in its container, so anything it writes into the
 * bind-mounted tree lands root-owned and the account that owns /opt/podhouse
 * cannot copy or delete its own backups.
 */
async function matchOwner(file) {
  try {
    const dir = await fsp.stat(ROOT);
    await fsp.chown(file, dir.uid, dir.gid);
  } catch {
    /* not root, or a filesystem that will not chown */
  }
}

/* ------------------------------------------------------------------ list */

async function list() {
  await ensureDir();
  let names = [];
  try {
    names = await fsp.readdir(BACKUP_DIR);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!NAME_RE.test(name)) continue;
    try {
      const st = await fsp.stat(path.join(BACKUP_DIR, name));
      out.push({
        name,
        size: st.size,
        created: st.mtimeMs,
        kind: name.includes('-full-') ? 'full' : 'config',
        encrypted: true,
      });
    } catch {
      /* vanished between readdir and stat */
    }
  }
  return out.sort((a, b) => b.created - a.created);
}

function resolveName(name) {
  if (!NAME_RE.test(name || '')) throw new BackupError(`not a backup filename: ${name}`);
  return path.join(BACKUP_DIR, name);
}

async function remove(name) {
  await fsp.rm(resolveName(name), { force: true });
}

/** Decrypt and authenticate an existing archive without writing anything. */
async function verify(name) {
  const file = resolveName(name);
  await decryptToSink(file, deriveKey(requireSecret()));
  return { name, ok: true };
}

/** Keep the newest `retention`, oldest first out. */
async function prune() {
  const schedule = await getSchedule();
  const keep = Math.max(1, Number(schedule.retention) || DEFAULT_SCHEDULE.retention);
  const all = await list();
  const removed = [];
  for (const b of all.slice(keep)) {
    await remove(b.name);
    removed.push(b.name);
  }
  return removed;
}

/* --------------------------------------------------- the copy off the box */

/**
 * A second home for every archive, on another machine.
 *
 * The archives above live inside the tree they protect, so a dead disk, or one
 * `rm -rf /opt/podhouse`, takes the backups along with everything else. That is
 * not a hypothetical; it is how this came to be written. When
 * HB_BACKUP_COPY_DIR names a directory — normally a NAS share mounted on the
 * host — every archive is copied there once it has been verified, and the copy
 * is verified again where it landed.
 *
 * The local archive stays. Restoring from the same disk is fast and works while
 * the NAS is off; the copy is the one that survives the box.
 *
 * A failed copy does not fail the backup. It is recorded and shown instead,
 * because a share that stopped accepting copies three weeks ago is precisely
 * the thing nobody notices until the day it matters.
 */
const COPY_STATE_FILE = 'backup-copy.json';

function copyDir() {
  return readEnvValue('HB_BACKUP_COPY_DIR');
}

/** null when the destination can take a copy right now, otherwise why not. */
async function copyProblem(dir) {
  if (!path.isAbsolute(dir)) return `${dir} is not an absolute path`;
  let st;
  try {
    st = await fsp.stat(dir);
  } catch {
    return `${dir} does not exist here. If it was just set, the dashboard needs recreating to see it — saving it in Settings does that.`;
  }
  if (!st.isDirectory()) return `${dir} is not a directory`;
  // The trap this exists for: a share that is not mounted leaves an ordinary
  // empty directory on the local disk at exactly the same path. Copies would
  // land on the very disk they are meant to outlive, and look like they worked.
  const home = await fsp.stat(ROOT);
  if (st.dev === home.dev) {
    return `${dir} is on this box's own disk. Is the NAS mounted? A share that mounted after the dashboard started is not seen until the dashboard is recreated.`;
  }
  return null;
}

async function readCopyState() {
  return state.readJson(COPY_STATE_FILE, {});
}

async function noteCopy(result) {
  const prev = await readCopyState();
  await state.writeJson(COPY_STATE_FILE, {
    ...result,
    at: Date.now(),
    lastOk: result.ok ? Date.now() : (prev.lastOk || null),
  });
  return result;
}

async function copyOffBox(name, secret) {
  const dir = copyDir();
  if (!dir) return null;

  const problem = await copyProblem(dir);
  if (problem) return noteCopy({ ok: false, dir, name, error: problem });

  const src = path.join(BACKUP_DIR, name);
  const tmp = scratchPath(dir, '.incoming');
  try {
    await pipeline(fs.createReadStream(src), fs.createWriteStream(tmp, { mode: 0o600 }));
    // Read the copy back through the cipher, as the local one was. A copy
    // nobody has decrypted is a copy nobody knows is whole — and a network
    // share is exactly where a truncated write goes unreported.
    await decryptToSink(tmp, deriveKey(secret));
    await fsp.rename(tmp, path.join(dir, name));
    await pruneCopies(dir);
    return noteCopy({ ok: true, dir, name, error: null });
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    return noteCopy({ ok: false, dir, name, error: err.message });
  }
}

/**
 * The same retention as the local directory, and only ever on files named
 * like our own archives: this directory is somebody's NAS, and anything else
 * in it is theirs.
 */
async function pruneCopies(dir) {
  const keep = (await getSchedule()).retention;
  const mine = [];
  for (const name of await fsp.readdir(dir)) {
    if (!NAME_RE.test(name)) continue;
    try {
      mine.push({ name, created: (await fsp.stat(path.join(dir, name))).mtimeMs });
    } catch {
      /* vanished between readdir and stat */
    }
  }
  mine.sort((a, b) => b.created - a.created);
  for (const old of mine.slice(keep)) await fsp.rm(path.join(dir, old.name), { force: true });
}

/** What the page says about the copy: configured, working now, and the last attempt. */
async function copyStatus() {
  const dir = copyDir();
  if (!dir) return { configured: false };
  const [problem, last] = await Promise.all([copyProblem(dir), readCopyState()]);
  let count = 0;
  if (!problem) {
    try {
      count = (await fsp.readdir(dir)).filter((n) => NAME_RE.test(n)).length;
    } catch {
      /* counted as none */
    }
  }
  return {
    configured: true,
    dir,
    problem,
    count,
    lastOk: last.lastOk || null,
    lastError: last.ok === false && last.dir === dir ? last.error : null,
  };
}

/* -------------------------------------------------------------- schedule */

async function getSchedule() {
  const saved = await state.readJson(SCHEDULE_FILE, DEFAULT_SCHEDULE);
  return {
    enabled: saved.enabled === true,
    preset: PRESETS[saved.preset] ? saved.preset : DEFAULT_SCHEDULE.preset,
    retention: Math.min(100, Math.max(1, Number(saved.retention) || DEFAULT_SCHEDULE.retention)),
    lastRun: Number(saved.lastRun) || null,
  };
}

async function setSchedule(input) {
  const next = {
    enabled: input.enabled === true,
    preset: PRESETS[input.preset] ? input.preset : DEFAULT_SCHEDULE.preset,
    retention: Math.min(100, Math.max(1, Number(input.retention) || DEFAULT_SCHEDULE.retention)),
    lastRun: (await getSchedule()).lastRun,
  };
  await state.writeJson(SCHEDULE_FILE, next);
  return next;
}

function nextRunAt(schedule) {
  if (!schedule.enabled) return null;
  const every = PRESETS[schedule.preset].everyMs;
  return (schedule.lastRun || Date.now()) + every;
}

/**
 * Checked once a minute rather than scheduled to the second: a home box gets
 * rebooted, and a timer armed for "in 23 hours" simply never fires. Comparing
 * against a persisted lastRun survives restarts.
 */
function startScheduler() {
  const tick = async () => {
    try {
      const schedule = await getSchedule();
      if (!schedule.enabled || inFlight) return;
      const due = nextRunAt(schedule);
      if (due && Date.now() >= due) {
        await create({ kind: 'config' });
        await state.writeJson(SCHEDULE_FILE, { ...schedule, lastRun: Date.now() });
      }
    } catch (err) {
      console.warn('[homebox] scheduled backup failed:', err.message);
    }
  };
  const timer = setInterval(tick, 60000);
  timer.unref();
  tick();
  return timer;
}

/* --------------------------------------------------------------- status */

/**
 * Backups written to the same filesystem as the thing they protect survive a
 * mistake but not a dead disk. Worth saying out loud rather than implying.
 */
async function sameDiskAsData() {
  try {
    const [backups, data] = await Promise.all([
      fsp.stat(BACKUP_DIR),
      fsp.stat(path.join(ROOT, 'data')).catch(() => fsp.stat(ROOT)),
    ]);
    return backups.dev === data.dev;
  } catch {
    return true;
  }
}

async function status() {
  const [backups, schedule, sameDisk, copy] = await Promise.all([
    list(), getSchedule(), sameDiskAsData(), copyStatus(),
  ]);
  const latest = backups[0] || null;
  return {
    directory: BACKUP_DIR,
    copy,
    hasKey: readKeyFromEnv() != null,
    count: backups.length,
    totalSize: backups.reduce((sum, b) => sum + b.size, 0),
    latest,
    sameDisk,
    running: inFlight,
    schedule: { ...schedule, nextRun: nextRunAt(schedule), presets: PRESETS },
    backups,
  };
}

/** The key itself, for the reveal button. */
function revealKey() {
  return { key: requireSecret() };
}

module.exports = {
  create, list, remove, verify, prune, status, copyStatus,
  getSchedule, setSchedule, startScheduler,
  revealKey, decryptFile, resolveName, BACKUP_DIR, BackupError, PRESETS, tarArgs, rebuildableExcludes };
