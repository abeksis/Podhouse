'use strict';
/**
 * Where the READ-ONLY half of Docker lives, for the web process.
 *
 * The dashboard still has to list containers, read logs, sample stats and
 * follow the event stream. None of that changes the box, so none of it needs
 * the real socket — and it must not have it, because holding the socket at all
 * is holding root: the file is one thing, and the API on the other side of it
 * is create-a-container-that-mounts-slash.
 *
 * So the web process talks to a socket proxy (haproxy, `tecnativa/docker-
 * socket-proxy`) that answers GET on containers, images, networks, events and
 * version, and refuses every write method outright. The same pattern the
 * Beszel agent has used since 0.8.1, now applied to the dashboard itself.
 *
 * HB_DOCKER_API is `host:port`. Without it this falls back to the unix socket,
 * which is what the CLI and the worker use — the same library files are loaded
 * in both places, and only the dashboard container is missing the socket.
 */

const SOCKET = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
const API = (process.env.HB_DOCKER_API || '').trim();

/**
 * Request options for one Docker API call, pointed at whichever endpoint this
 * process is supposed to use.
 *
 * `Host: docker` is kept for the unix case because there is no real host name
 * to send; over TCP the proxy's own name is the right value and haproxy is
 * fussier about it than the engine is.
 */
function options(path, method = 'GET', extra = {}) {
  if (API) {
    const [host, port] = API.split(':');
    return { host, port: Number(port) || 2375, path, method, headers: { Host: host, ...(extra.headers || {}) }, ...strip(extra) };
  }
  return { socketPath: SOCKET, path, method, headers: { Host: 'docker', ...(extra.headers || {}) }, ...strip(extra) };
}

const strip = ({ headers, ...rest }) => rest;

/** True when this process reads Docker through the restricted proxy. */
const isProxied = () => !!API;

/** For messages: what this process is actually talking to. */
const describe = () => (API ? `${API} (read-only proxy)` : SOCKET);

module.exports = { options, isProxied, describe, SOCKET, API };
