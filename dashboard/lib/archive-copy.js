'use strict';
/**
 * Copy one backup archive into the off-box folder, and prove it arrived whole.
 *
 * Deliberately standalone — fs, path and crypto, nothing from this project —
 * because it runs in two places:
 *
 *   - on the host, from the CLI, where the folder is simply there;
 *   - inside a throwaway container the dashboard starts for this one job
 *     (`node /app/lib/archive-copy.js <name> <keep>`, with the local backups
 *     at /src and the destination at /dst). The dashboard itself never mounts
 *     the destination: a NAS that is down at boot must not be able to stop the
 *     dashboard from starting, and a bind mount on the dashboard would.
 *
 * It needs no key. The archive was decrypted and authenticated before it was
 * allowed to exist; a copy with the same SHA-256 is that same verified file.
 */

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const NAME_RE = /^homebox-(config|full)-\d{8}_\d{6}\.tar\.gz\.enc$/;

class CopyError extends Error {}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * @returns {{ count: number }} how many of our archives the folder now holds
 */
async function copyInto({ srcDir, destDir, name, keep }) {
  if (!NAME_RE.test(name || '')) throw new CopyError(`not a backup filename: ${name}`);

  let dest;
  try {
    dest = await fsp.stat(destDir);
  } catch {
    throw new CopyError(`${destDir} does not exist. Is the NAS mounted?`);
  }
  if (!dest.isDirectory()) throw new CopyError(`${destDir} is not a directory`);
  // The trap this exists for: a share that is not mounted leaves an ordinary
  // directory on the local disk at the same path. A copy would land on the
  // very disk it is meant to outlive, and look like it worked.
  if (dest.dev === (await fsp.stat(srcDir)).dev) {
    throw new CopyError(`${destDir} is on this box's own disk. Is the NAS mounted?`);
  }

  const src = path.join(srcDir, name);
  const tmp = path.join(destDir, `.incoming-${crypto.randomBytes(6).toString('hex')}`);
  try {
    await fsp.copyFile(src, tmp);
    await fsp.chmod(tmp, 0o600);
    // Read back from the far side. A network share is exactly where a
    // truncated write goes unreported.
    const [a, b] = await Promise.all([sha256(src), sha256(tmp)]);
    if (a !== b) throw new CopyError('the copy does not match the archive — the NAS returned different bytes');
    await fsp.rename(tmp, path.join(destDir, name));
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }

  // The same retention as the local folder, and only ever files named like
  // our own archives: this folder is somebody's NAS, and the rest is theirs.
  const mine = [];
  for (const entry of await fsp.readdir(destDir)) {
    if (!NAME_RE.test(entry)) continue;
    try {
      mine.push({ entry, at: (await fsp.stat(path.join(destDir, entry))).mtimeMs });
    } catch {
      /* vanished between readdir and stat */
    }
  }
  mine.sort((x, y) => y.at - x.at);
  const limit = Math.max(1, Number(keep) || 7);
  for (const old of mine.slice(limit)) await fsp.rm(path.join(destDir, old.entry), { force: true });
  return { count: Math.min(mine.length, limit) };
}

module.exports = { copyInto, CopyError, NAME_RE };

// Inside the helper container: one line of JSON on stdout, always, so the
// dashboard reads a result rather than guessing from an exit code.
if (require.main === module) {
  const [name, keep] = process.argv.slice(2);
  copyInto({ srcDir: '/src', destDir: '/dst', name, keep })
    .then((r) => console.log(JSON.stringify({ ok: true, ...r })))
    .catch((err) => {
      console.log(JSON.stringify({ ok: false, error: err.message }));
      process.exitCode = 1;
    });
}
