#!/usr/bin/env node
'use strict';
/**
 * What would stop each module running under ROOTLESS Docker.
 *
 * Rootless dockerd runs as an ordinary user, and the things it cannot do are
 * well known and visible in a compose file. This reads every module and says
 * which of them it hits, so the measurement on a real rootless box starts from
 * a list of predictions instead of seventy image pulls and a shrug.
 *
 * It is a PREDICTION, and it is written down as one. Run it, then run
 * scripts/try-modules.sh against a rootless daemon and compare — a blocker
 * this misses is the interesting result, and the reason the trial still has
 * to happen.
 *
 *   node scripts/rootless-scan.js            # a table
 *   node scripts/rootless-scan.js --json     # the same, machine readable
 */

const fs = require('fs');
const path = require('path');

const ROOT = process.env.HOMEBOX_ROOT || path.join(__dirname, '..');
const MODULES = path.join(ROOT, 'modules');

/**
 * Each check says what it found, how bad it is, and what a user could do.
 *
 *   'blocked'  — will not run without changing the module
 *   'needs'    — runs once the box is configured for it, once
 *   'note'     — runs, with something worth knowing
 */
const CHECKS = [
  {
    id: 'low-port',
    level: 'needs',
    why: 'binds a port below 1024',
    fix: 'sysctl net.ipv4.ip_unprivileged_port_start=80, or publish it higher',
    find: (text) => {
      const hits = [];
      for (const raw of text.matchAll(/^\s*-\s*(.+)$/gm)) {
        // ${HTTP_PORT:-80} is resolved to its default BEFORE anything is
        // split on a colon, because the `:-` inside it is a colon too: split
        // first and "${HTTP_PORT:-80}:80" becomes three fields, none of which
        // is a port. That is how a scan of this project first reported that
        // its own reverse proxy does not bind 80 or 443.
        const line = raw[1].trim()
          .replace(/^["']|["']$/g, '')
          .replace(/\/(tcp|udp)$/, '')
          // Any default, not just a numeric one: pi-hole publishes
          // "${HB_HOST_ADDRESS:-0.0.0.0}:53:53/tcp", whose default is an
          // address. Matching only digits here missed port 53 on the one
          // module whose whole job is port 53.
          .replace(/\$\{[A-Za-z_][A-Za-z0-9_]*:-([^}]*)\}/g, '$1');
        const parts = line.split(':');
        if (parts.length < 2 || parts.length > 3) continue;
        const container = parts[parts.length - 1];
        if (!/^\d{1,5}$/.test(container)) continue;
        const host = parts[parts.length - 2];
        if (!/^\d{1,5}$/.test(host)) continue;
        const port = Number(host);
        if (port < 1024) hits.push(port);
      }
      return hits.length ? [...new Set(hits)].sort((a, b) => a - b).join(', ') : null;
    },
  },
  {
    id: 'host-network',
    level: 'blocked',
    why: 'uses the host network namespace',
    fix: 'none from here — rootless has its own namespace, so "the host" is not the host',
    find: (text) => (/^\s*network_mode:\s*["']?host["']?\s*$/m.test(text) ? 'network_mode: host' : null),
  },
  {
    id: 'device',
    level: 'blocked',
    why: 'asks for a host device',
    fix: 'depends on the device: /dev/net/tun and /dev/dri need rules a rootless daemon cannot grant itself',
    find: (text) => {
      const hits = [...text.matchAll(/^\s*-\s*["']?(\/dev\/[^\s:"']+)/gm)].map((m) => m[1]);
      return hits.length ? [...new Set(hits)].join(', ') : null;
    },
  },
  {
    id: 'privileged',
    level: 'blocked',
    why: 'asks for privileged',
    fix: 'none — a rootless daemon has nothing to hand over',
    find: (text) => (/^\s*privileged:\s*true\s*$/m.test(text) ? 'privileged: true' : null),
  },
  {
    id: 'admin-caps',
    level: 'blocked',
    why: 'asks for a capability rootless cannot give',
    fix: 'none for NET_ADMIN and SYS_ADMIN — they are the ones the user does not have to give',
    find: (text) => {
      const hits = [...text.matchAll(/^\s*-\s*(NET_ADMIN|SYS_ADMIN|SYS_MODULE|NET_RAW)\s*$/gm)].map((m) => m[1]);
      return hits.length ? [...new Set(hits)].join(', ') : null;
    },
  },
  {
    id: 'docker-socket',
    level: 'note',
    why: 'mounts the Docker socket',
    fix: 'works, but it is the ROOTLESS socket: it can only see this user\'s containers',
    find: (text) => (/\/var\/run\/docker\.sock/.test(text) ? '/var/run/docker.sock' : null),
  },
  {
    id: 'host-path',
    level: 'note',
    why: 'mounts a path outside the Podhouse tree',
    fix: 'the unprivileged user must be able to read it — root-owned paths will not open',
    find: (text) => {
      const hits = [];
      for (const m of text.matchAll(/^\s*-\s*(\/[^\s:$][^\s:]*):/gm)) {
        const p = m[1];
        if (p.startsWith('/dev/') || p === '/var/run/docker.sock') continue;
        hits.push(p);
      }
      return hits.length ? [...new Set(hits)].join(', ') : null;
    },
  },
  {
    id: 'pid-host',
    level: 'blocked',
    why: 'wants the host PID namespace',
    fix: 'none — rootless cannot see the host\'s processes',
    find: (text) => (/^\s*pid:\s*["']?host["']?\s*$/m.test(text) ? 'pid: host' : null),
  },
];

const LEVEL_ORDER = { blocked: 0, needs: 1, note: 2, clean: 3 };

function scan() {
  const rows = [];
  for (const id of fs.readdirSync(MODULES).sort()) {
    const file = path.join(MODULES, id, 'docker-compose.yml');
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    const findings = [];
    for (const check of CHECKS) {
      const found = check.find(text);
      if (found) findings.push({ ...check, found });
    }
    const worst = findings.reduce(
      (acc, f) => (LEVEL_ORDER[f.level] < LEVEL_ORDER[acc] ? f.level : acc), 'clean');
    rows.push({ id, verdict: worst, findings: findings.map((f) => ({ id: f.id, level: f.level, why: f.why, found: f.found, fix: f.fix })) });
  }
  return rows;
}

const rows = scan();

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  const counts = { blocked: 0, needs: 0, note: 0, clean: 0 };
  for (const r of rows) counts[r.verdict] += 1;
  const mark = { blocked: 'NO  ', needs: 'CFG ', note: 'ok? ', clean: 'ok  ' };
  for (const r of rows.sort((a, b) => LEVEL_ORDER[a.verdict] - LEVEL_ORDER[b.verdict] || a.id.localeCompare(b.id))) {
    const detail = r.findings.length
      ? r.findings.map((f) => `${f.why} (${f.found})`).join('; ')
      : '';
    console.log(`${mark[r.verdict]} ${r.id.padEnd(16)} ${detail}`);
  }
  console.log('');
  console.log(`${rows.length} modules — ${counts.clean} clean, ${counts.note} probably fine, `
    + `${counts.needs} need the box configured, ${counts.blocked} cannot run rootless as written`);
  console.log('This is a prediction from the compose files. Confirm it with scripts/try-modules.sh');
  console.log('against a rootless daemon before publishing any of it.');
}
