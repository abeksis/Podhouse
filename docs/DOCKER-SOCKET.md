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
| `dashboard` | read-write | creates, starts, stops and deletes containers; builds and pulls images; creates networks |
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

**3. Split the dashboard.** The only real fix: the web process holds no socket
and talks to a small privileged worker over a unix socket of our own, whose
API is not "run this Docker request" but `install <module id>`, `up <id>`,
`down <id>`, `restart <container of id>`. The worker validates the id against
the catalog on disk and runs compose itself. Then a hole in the web process
buys an attacker the ability to restart Jellyfin, not to mount `/`.

That is a real piece of work and it is the one that matters. Stages 1 and 2
are worth having on their own, and neither of them is a substitute for it.

## If you are reading this to decide whether to expose the dashboard

Don't. It is a LAN tool with a login, and everything above is the reason:
until stage 3 lands, a session on this page is a session with root on the box.
Remote access belongs behind one of the VPN modules — see `docs/SECURITY.md`.
