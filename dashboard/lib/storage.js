'use strict';
/**
 * Network storage — asked for, not done here.
 *
 * The implementation is in lib/storage-privileged.js and runs in the worker,
 * for a sharper reason than the compose split. Mounting an NFS share happens
 * on the HOST, and the old code reached it by running a `--privileged
 * --pid=host` container with `nsenter` and an argv handed in by this process.
 * That is not "root-equivalent if you chain a few things" — it is a function
 * in the web process that runs any command as root on the machine.
 *
 * What crosses now is an address and a path, validated on the far side.
 * `onHostDetached` is gone from this surface entirely: there is no longer a
 * way to say "run this on the host", only `selfUpdate(version)`, which builds
 * its own command around a version string that has to look like 1.2.3.
 */

const worker = require('./worker-client');

const StorageError = worker.WorkerError;

/** What is mounted right now, and what this box can see. */
const list = () => worker.call('storage.list');

/** Ask a server what it exports, and whether this box may have it. */
const probe = ({ kind, server } = {}) => worker.call('storage.probe', { kind, server });

const mount = (input, { onLine = null } = {}) => worker.call('storage.mount', input || {}, onLine);

const unmount = ({ mountpoint } = {}) => worker.call('storage.unmount', { mountpoint });

const removeHelper = (name) => worker.call('storage.removeHelper', { name });

/**
 * Start the platform updater on the host, detached.
 *
 * The replacement for onHostDetached(argv). The only thing this can start is
 * scripts/self-update.sh, and the only thing it can pass is a version — the
 * worker checks it against N.N.N and builds the rest of the command there.
 */
const selfUpdate = (version) => worker.call('platform.selfUpdate', { version });

module.exports = { list, probe, mount, unmount, removeHelper, selfUpdate, StorageError };
