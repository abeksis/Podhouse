'use strict';
/**
 * The privileged worker.
 *
 * This process holds /var/run/docker.sock. The web process does not, and that
 * swap is the whole reason this file exists: write access to that socket is
 * root on the box, because anything that can create a container can create one
 * that bind-mounts / and runs as root. While the dashboard held it, a session
 * on the page was a session with root, and every XSS or stolen cookie was a
 * full compromise of the machine.
 *
 * What crosses the boundary is a NAMED OPERATION and never a command line.
 * `install`, `stop`, `mount` — with a module id or a container name as the
 * only parameter, validated here against the catalog on disk. The argument
 * vectors are built on this side, from constants in this file and in
 * lib/compose-privileged.js.
 *
 * That is not the same as an allowlist over the Docker API, and the difference
 * is the point. A proxy that permits POST /containers/create is
 * root-equivalent however many other endpoints it blocks — the attacker simply
 * asks for the container they want. Here there is no request to shape: an
 * attacker who owns the web process can ask for `install radarr`, and what
 * they get is Radarr.
 *
 * Runs in its own container from the same image as the dashboard, started by
 * modules/dashboard/docker-compose.yml.
 */

const fs = require('fs');
const net = require('net');
const path = require('path');

const { SOCKET_PATH, framer, encode, ROOT } = require('./lib/worker-protocol');
const compose = require('./lib/compose-privileged');
const storage = require('./lib/storage-privileged');
// Here the Docker library talks to the real socket: HB_DOCKER_API is not set
// in this container, so lib/docker-endpoint.js falls back to it.
const docker = require('./lib/docker');

const log = (...parts) => console.log('[worker]', ...parts);

/* ------------------------------------------------------------ the op table
 *
 * Every entry takes the arguments it needs BY NAME and builds its own command.
 * There is no entry that forwards an argv, and there must never be one: the
 * moment one exists, this file is a remote shell with extra steps.
 */

const ops = {
  ping: async () => 'ok',

  install: ({ id }, onLine) => compose.install(id, { onLine }),
  start: ({ id }, onLine) => compose.start(id, { onLine }),
  stop: ({ id }, onLine) => compose.stop(id, { onLine }),
  restart: ({ id }, onLine) => compose.restart(id, { onLine }),
  down: ({ id }, onLine) => compose.down(id, { onLine }),
  purge: ({ id }, onLine) => compose.purge(id, { onLine }),
  update: ({ id }, onLine) => compose.update(id, { onLine }),
  pull: ({ id }, onLine) => compose.pull(id, { onLine }),
  runSetup: ({ id }, onLine) => compose.runSetup(id, { onLine }),

  pullService: ({ id, service }, onLine) => compose.pullService(id, service, { onLine }),
  upService: ({ id, service }, onLine) => compose.upService(id, service, { onLine }),
  stopService: ({ id, service }, onLine) => compose.stopService(id, service, { onLine }),
  restartService: ({ id, service }, onLine) => compose.restartService(id, service, { onLine }),

  containerAction: ({ name, action }, onLine) => compose.containerAction(name, action, { onLine }),
  retag: ({ imageId, ref }) => compose.retag(imageId, ref),
  selfRecreate: ({ image }) => compose.selfRecreate(image),
  copyArchiveOut: (args) => compose.copyArchiveOut(args),

  // The storage side, which is the other place the old code could reach the
  // host: it ran nsenter in a --privileged --pid=host container with an argv
  // handed to it from the web process. Now the argv is built here, from a
  // server address and an export path that this side validates.
  'storage.list': () => storage.list(),
  'storage.probe': ({ kind, server }) => storage.probe({ kind, server }),
  'storage.mount': (args, onLine) => storage.mount(args, { onLine }),
  'storage.unmount': (args, onLine) => storage.unmount(args, { onLine }),
  'storage.removeHelper': ({ name }) => storage.removeHelper(name),

  // The platform updater. A version, and nothing else: the command around it
  // is fixed in lib/storage-privileged.js.
  'platform.selfUpdate': ({ version }) => storage.selfUpdate(version),

  // Settings → Tools → Clean up. It takes no arguments at all: the filter —
  // dangling layers only, never a tagged image — is fixed in lib/docker.js.
  //
  // It was the one Docker write the 0.15.0 split left in the web process, and
  // it had been failing ever since. The web process reads Docker through a
  // proxy started with POST=0, so the prune came back 403 "Request forbidden
  // by administrative rules" — which is the proxy doing its job. Nobody
  // noticed for four releases because the button is two tabs deep and is
  // rarely pressed; it was found when someone pressed it.
  'images.pruneDangling': () => docker.pruneDangling(),
};

/* -------------------------------------------------------------- one request
 *
 * One connection carries one call. The connection is answered with exactly one
 * terminal frame, always — a worker that returns nothing reads to the client
 * as a failure, which is the right way round, but an unexplained failure is
 * not worth shipping when the reason is known here.
 */

function serve(socket) {
  let handled = false;

  const answer = (frame) => {
    if (handled) return;
    handled = true;
    try { socket.write(encode(frame)); } catch { /* the caller went away */ }
    socket.end();
  };

  const feed = framer(async (frame) => {
    if (handled) return;
    const op = ops[frame.op];
    if (!op) {
      log('refused an unknown op:', JSON.stringify(String(frame.op)).slice(0, 80));
      answer({ ok: false, error: `unknown operation: ${frame.op}` });
      return;
    }
    const args = frame.args && typeof frame.args === 'object' ? frame.args : {};
    const onLine = (line, err) => {
      if (handled) return;
      try { socket.write(encode({ line: String(line), err: !!err })); } catch { /* gone */ }
    };

    try {
      const result = await op(args, onLine);
      answer({ ok: true, result: result === undefined ? null : result });
    } catch (err) {
      // The failing command's own output travels back, so the dialog the user
      // reads is the one compose wrote — the move must not cost the reason.
      answer({
        ok: false,
        error: err.message || String(err),
        detail: { code: err.code, stdout: err.stdout, stderr: err.stderr },
      });
    }
  });

  socket.on('data', (chunk) => {
    try { feed(chunk); } catch (err) { answer({ ok: false, error: err.message }); }
  });
  socket.on('error', () => { /* a client that hangs up mid-call is ordinary */ });
}

/* ------------------------------------------------------------------ listen */

function listen() {
  // A socket file left by a killed worker keeps the new one from binding, and
  // the box then cannot install anything until somebody deletes a file they
  // have never heard of.
  try {
    if (fs.existsSync(SOCKET_PATH)) fs.unlinkSync(SOCKET_PATH);
  } catch (err) {
    console.error(`[worker] cannot clear ${SOCKET_PATH}: ${err.message}`);
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(SOCKET_PATH), { recursive: true });

  const server = net.createServer(serve);
  server.on('error', (err) => {
    console.error(`[worker] ${err.message}`);
    process.exit(1);
  });

  server.listen(SOCKET_PATH, () => {
    // 0660: the dashboard container reaches this through the shared tree, and
    // nothing else on the box has a reason to. It is not the security boundary
    // — the boundary is that the only things askable are the ops above — but a
    // world-writable control socket would be a silly way to undo the work.
    try { fs.chmodSync(SOCKET_PATH, 0o660); } catch { /* best effort */ }
    log(`listening on ${SOCKET_PATH}`);
    log(`serving ${Object.keys(ops).length} operations for ${ROOT}`);
  });

  const shutdown = (signal) => {
    log(`${signal} — closing`);
    server.close(() => {
      try { fs.unlinkSync(SOCKET_PATH); } catch { /* already gone */ }
      process.exit(0);
    });
    // A pull in flight should not hold the box hostage at shutdown.
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

listen();
