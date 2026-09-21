'use strict';
/**
 * The wire between the web process and the privileged worker.
 *
 * Both sides load this file, so the framing exists once. It is deliberately
 * the dullest protocol that does the job: newline-delimited JSON over a unix
 * socket, one request per connection, no multiplexing, no ids to correlate.
 *
 * One request per connection is not laziness. A multiplexed channel needs a
 * correlation id on every frame, and a bug in that bookkeeping delivers one
 * caller's output to another caller — on a channel whose whole purpose is
 * privileged operations. A connection that carries exactly one call cannot
 * make that mistake.
 *
 *   -> {"op":"install","args":{"id":"radarr"}}
 *   <- {"line":"==> Pulling images for radarr","err":false}
 *   <- {"line":" radarr Pulled","err":false}
 *   <- {"ok":true,"result":{"stdout":"…","stderr":""}}
 *
 * or, at the end of a failure:
 *
 *   <- {"ok":false,"error":"compose exited 1","detail":{"code":1,"stderr":"…"}}
 *
 * The worker always ends a connection with exactly one terminal frame, and
 * the client treats a closed connection without one as a failure — a worker
 * that dies mid-install must not read as a successful install.
 */

const path = require('path');

const ROOT = process.env.HOMEBOX_ROOT || '/opt/podhouse';

/**
 * Where the socket lives.
 *
 * Under state/ because that is the one directory both containers already
 * share, and because it is on the box's own disk rather than in a volume that
 * an app could be given by accident.
 */
const SOCKET_PATH = process.env.HB_WORKER_SOCKET || path.join(ROOT, 'state', 'worker.sock');

/** A line of JSON, or null for anything that does not parse. */
function parseFrame(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

/**
 * Split a stream of bytes into frames.
 *
 * A chunk from a socket is not a line — it can hold half a frame, or three of
 * them. Every reader here goes through this so that neither side has to get
 * the buffering right twice.
 */
function framer(onFrame) {
  let buffer = '';
  return (chunk) => {
    buffer += chunk.toString('utf8');
    // A single frame carrying a whole install transcript is still bounded by
    // the 64KB cap the runner applies; this guard is for a peer that is not
    // speaking the protocol at all.
    if (buffer.length > 8 * 1024 * 1024) {
      buffer = '';
      throw new Error('worker protocol: a frame grew past 8MB without a newline');
    }
    const parts = buffer.split('\n');
    buffer = parts.pop();
    for (const part of parts) {
      if (!part.trim()) continue;
      const frame = parseFrame(part);
      if (frame) onFrame(frame);
    }
  };
}

const encode = (frame) => JSON.stringify(frame) + '\n';

module.exports = { SOCKET_PATH, framer, encode, parseFrame, ROOT };
