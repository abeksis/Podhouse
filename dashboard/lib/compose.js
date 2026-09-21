'use strict';
/**
 * Everything that changes the box — asked for, not done here.
 *
 * This file used to BE the implementation: it held /var/run/docker.sock and
 * shelled out to `docker compose`. That made the web process root on the box,
 * because anything that can create a container can create one that mounts /
 * and runs as root. A session on the dashboard was a session with root.
 *
 * The implementation now lives in lib/compose-privileged.js and runs in a
 * separate container that holds the socket and nothing else of interest. What
 * is left here is a client with the same function names and the same
 * arguments, so every caller in this codebase is unchanged — and every one of
 * those calls now crosses a boundary where the only things that can be asked
 * for are the operations named below.
 *
 * Adding a capability means adding an op to worker.js. That is the point: it
 * is meant to be a visible act rather than a new argument to a generic runner.
 */

const worker = require('./worker-client');

// A module id becomes part of a filesystem path and a compose project name.
// Kept here as well as in the worker — this side uses it to reject nonsense
// early and give a better message, and the worker uses it because a check
// that only runs on the caller's side is not a check.
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

const CONTAINER_ACTIONS = new Set(['start', 'stop', 'restart']);

/**
 * What callers catch. The worker sends back the failing command's exit code
 * and output, so `err.stderr` still holds what compose printed — the error a
 * user sees in the install dialog is unchanged by the move.
 */
const ComposeError = worker.WorkerError;

const byId = (op) => (id, { onLine = null } = {}) => worker.call(op, { id }, onLine);
const byService = (op) => (id, service, { onLine = null } = {}) => worker.call(op, { id, service }, onLine);

const install = byId('install');
const start = byId('start');
const stop = byId('stop');
const restart = byId('restart');
const down = byId('down');
const purge = byId('purge');
const update = byId('update');
const pull = byId('pull');
const runSetup = byId('runSetup');

const pullService = byService('pullService');
const upService = byService('upService');
const stopService = byService('stopService');
const restartService = byService('restartService');

/** Start, stop or restart one container by name. */
const containerAction = (name, action, { onLine = null } = {}) =>
  worker.call('containerAction', { name, action }, onLine);

/** Point a tag back at an image still on disk — the update rollback. */
const retag = (imageId, ref) => worker.call('retag', { imageId, ref });

/** Recreate the dashboard from outside the dashboard. */
const selfRecreate = (image) => worker.call('selfRecreate', { image });

/** Copy one archive off the box, from a container that exists only for it. */
const copyArchiveOut = (options) => worker.call('copyArchiveOut', options || {});

/**
 * Can work be done at all?
 *
 * The question used to be "is `docker compose` usable from this container",
 * and the honest answer now is "is the worker answering" — the web process
 * has no Docker of its own to test, and a box whose worker is down cannot
 * install anything no matter how healthy Docker is.
 */
const available = () => worker.ping();

module.exports = {
  install, start, stop, restart, down, purge, update, pull, available, runSetup,
  pullService, upService, stopService, restartService, retag, selfRecreate, copyArchiveOut,
  containerAction, CONTAINER_ACTIONS, ComposeError, ID_PATTERN,
};
