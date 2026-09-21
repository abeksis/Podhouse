'use strict';
/**
 * How the web process asks for something it is not allowed to do itself.
 *
 * The dashboard no longer holds /var/run/docker.sock. It holds one unix
 * socket of our own, and everything on the other side of it is a NAMED
 * operation — `install`, `stop`, `mount` — never "run this Docker request".
 * The worker builds every argument vector itself from a validated id.
 *
 * That distinction is the entire point. An allowlist that keeps
 * POST /containers/create is root-equivalent: a container can be asked for
 * that bind-mounts / and runs as root. A hole in this process buys an
 * attacker the ability to restart Jellyfin.
 */

const net = require('net');

const { SOCKET_PATH, framer, encode } = require('./worker-protocol');

class WorkerError extends Error {
  constructor(message, { code, stdout, stderr, op } = {}) {
    super(message);
    this.name = 'WorkerError';
    this.code = code;
    this.stdout = stdout;
    this.stderr = stderr;
    this.op = op;
  }
}

/**
 * Ask the worker to do one thing.
 *
 * `onLine(line, isErr)` receives output as it happens, so an install still
 * streams to the browser exactly as it did when the web process ran compose
 * itself — the worker forwards the same lines the same way.
 *
 * The timeout is the worker's to enforce, not this side's: a client that
 * gives up does not stop a pull that is halfway through, and a second call
 * arriving because the first "timed out" is how a box ends up running two
 * installs of the same module at once.
 */
function call(op, args = {}, onLine = null) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => { if (!settled) { settled = true; fn(value); } };

    const socket = net.createConnection(SOCKET_PATH);
    socket.setNoDelay(true);

    const feed = framer((frame) => {
      if (typeof frame.line === 'string') {
        if (onLine) onLine(frame.line, !!frame.err);
        return;
      }
      if (frame.ok === true) {
        finish(resolve, frame.result === undefined ? null : frame.result);
        socket.end();
        return;
      }
      if (frame.ok === false) {
        const detail = frame.detail || {};
        finish(reject, new WorkerError(frame.error || `${op} failed`, { ...detail, op }));
        socket.end();
      }
    });

    socket.on('connect', () => socket.write(encode({ op, args })));
    socket.on('data', (chunk) => {
      try { feed(chunk); } catch (err) { finish(reject, new WorkerError(err.message, { op })); socket.destroy(); }
    });

    socket.on('error', (err) => {
      // The common case in development and the one worth naming: the worker
      // container is not running, so nothing can install and the reason is
      // not "permission denied" anywhere.
      const why = err.code === 'ENOENT' || err.code === 'ECONNREFUSED'
        ? `the privileged worker is not running (${SOCKET_PATH})`
        : `cannot reach the privileged worker: ${err.message}`;
      finish(reject, new WorkerError(why, { op }));
    });

    // A connection that closes without a terminal frame is a failure. Saying
    // otherwise would report a worker that died mid-install as a success.
    socket.on('close', () => {
      finish(reject, new WorkerError(`the privileged worker closed the connection during ${op}`, { op }));
    });
  });
}

/** Is the worker there at all? Used by the startup check, not by callers. */
async function ping() {
  try {
    await call('ping');
    return true;
  } catch {
    return false;
  }
}

module.exports = { call, ping, WorkerError, SOCKET_PATH };
