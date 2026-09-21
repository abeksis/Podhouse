# The Docker socket

Write access to `/var/run/docker.sock` is root on this box: anything that can
create a container can create one that mounts `/` and runs as root. This page
is the inventory of who holds that key here, exactly what each holder uses it
for, and what a filtered proxy can and cannot fix.

It exists because "we put a socket proxy in front of it" is the usual answer,
and for the dashboard as it is built today that answer would be theatre.

## Who holds it

| Container | Mount | What it does with it |
|---|---|---|
| `dashboard` | **none** | the web process holds no socket at all since 0.15.0 |
| `dashboard-worker` | read-write | the same work, behind a named-operation API — see below |
| `dashboard-socket` | proxied, read-only | what the page reads: containers, logs, stats, events |
| `portainer` | read-write | everything, by design — it is a general Docker UI. Not installed on a new box since 0.9.0 |
| `beszel-agent` | proxied, read-only | lists containers and reads their stats, so the graphs have names |

A `:ro` mount on the socket means nothing: the flag applies to the file, and
every write happens through the API on the other side of it. Only a proxy, or
not mounting it, actually restricts anything.

## What the dashboard actually calls

Direct Engine API calls, from `dashboard/lib` — this list is complete:

| Method | Path | Why |
|---|---|---|
| GET | `/_ping` | is Docker there |
| GET | `/version` | shown in Settings |
| GET | `/containers/json?all=1` | the app list and every status on the page |
| GET | `/containers/<name>/logs` | Live logs, and the first-login credential scan |
| GET | `/containers/<name>/stats?stream=false` | the memory and CPU on each card |
| GET | `/events` | the "What changed" feed |
| GET | `/networks` | whether the proxy network exists |
| GET | `/images/json` | which images are present, and the dangling sweep |
| GET | `/images/<ref>/json` | does this exact image still exist |
| POST | `/images/prune?filters=dangling` | "Clear leftover layers" |

All of that is READ, apart from the one prune.

The rest of the dashboard's work goes through the `docker` CLI, and that is
where the real privilege lives:

- `docker compose up -d --build`, `down`, `pull`, `config`, `ps` — per module
- `docker tag` — pinning a rebuilt image
- `docker restart|stop|start <container>` — the per-app buttons
- `docker run --detach …` — the helper that recreates the dashboard itself,
  because a container cannot replace itself while running

Compose needs container create, start, delete, image build and pull, and
network create. **Any allowlist that keeps those is root-equivalent**: with
`POST /containers/create` permitted, a compromised dashboard can ask for a
container that bind-mounts the host filesystem. A proxy in front of the
dashboard would block `/exec` and `/swarm` and leave the actual path to root
open. That is why it has not been done and why doing it would be worse than
useless: it would read as a mitigation in a table.

## What is worth doing, in order

**1. Proxy the holders that only read.** `beszel-agent` needs container names
and stats and nothing else, so it now talks to a `docker-socket-proxy` with
`CONTAINERS=1` and every write method refused, instead of holding the socket.
Done; see `modules/metrics/docker-compose.yml`.

**2. Make Portainer a choice rather than a default.** Done in 0.9.0: it is an
app in the store (`modules/portainer`) instead of half of `core`, so a new box
has one holder of the socket rather than two. A box that already ran it keeps
it running and keeps its settings — the old definition stays in `core` behind
a Compose profile, which is what stops `up --remove-orphans` from deleting a
container that is no longer being asked for.

**3. Split the dashboard.** Done in 0.15.0. The web process holds no socket and
talks to `dashboard-worker` over a unix socket in `state/`, whose API is not
"run this Docker request" but `install <id>`, `stop <id>`, `restartService <id>
<service>`, `storage.mount <share>`, `platform.selfUpdate <version>`. Every
argument vector is built on the worker's side from a validated id; there is no
operation that forwards an argv, and adding one would undo this.

Reads go to `dashboard-socket`, a `docker-socket-proxy` with `POST=0`.

Measured on a test box after the change: the web container has no
`/var/run/docker.sock`; a `POST /containers/create` from it asking for
`Binds: ["/:/host"]` and `Privileged: true` is answered `403 Forbidden`; and
`worker-client.call("exec", …)` is refused with `unknown operation: exec` and
logged. Installing, purging and restarting from the page all still work,
through the worker.

What this does NOT do: the worker can still do anything Docker can, so a flaw
in the worker's own argument handling is still a path to root. The surface is
one file and about twenty operations, which is a thing that can be read in an
afternoon — that is the improvement, not a proof.

## If you are reading this to decide whether to expose the dashboard

Still don't. Stage 3 means a session on this page is no longer a session with
root — it is a session that can install, remove and restart apps, which is
quite enough to ruin your day.
Remote access belongs behind one of the VPN modules — see `docs/SECURITY.md`.
