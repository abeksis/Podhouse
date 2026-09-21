# Rootless Docker

Podhouse runs on a normal, root-owned Docker daemon. This page is about the
other option — `dockerd` running as an ordinary user — and it exists because
"just run it rootless" is a common answer to the socket problem and deserves a
measured reply rather than an opinion.

Short version: most of the catalog would run, the reverse proxy needs one
sysctl, about eight modules cannot run as written, and the cost is not where
people expect it. **Nothing here changes how Podhouse installs today.**

## What was measured, and what was not

`scripts/rootless-scan.js` reads every module and predicts what would stop it.
That is a prediction from a file, and the file says so.

On 2026-09-21 a rootless daemon (Docker 29.8.0, `rootlesskit`) was installed
for an unprivileged user on a test box, alongside the normal one, and three
modules were actually run on it: one the scan called clean, one it said needed
configuration, and one it said was blocked. **The other 67 have not been run.**

## The prediction

70 modules: 56 clean, 5 with something worth knowing, 1 needing the box
configured, 8 that cannot run as written.

The eight: `changedetection` (SYS_ADMIN), `coolercontrol` (host network,
privileged), `dns` and `pi-hole` (NET_RAW, port 53), `homeassistant` (host
network, privileged), `metrics` (host network — a host metrics agent inside a
user namespace is not measuring the host), `tailscale` (`/dev/net/tun`,
NET_ADMIN), `vpn` (NET_ADMIN, SYS_MODULE).

Regenerate it with `node scripts/rootless-scan.js`.

## What actually happened

**`bookmarks` (Linkding) — works.** Pulled, started, healthy, answered. No
configuration, no surprises. This is what most of the catalog looks like.

**`core` (Nginx Proxy Manager) — works, after one sysctl.** The first attempt
failed exactly as predicted, and the daemon says what to do:

```
cannot expose privileged port 80, you can add
'net.ipv4.ip_unprivileged_port_start=80' to /etc/sysctl.conf (currently 1024)
```

With the floor lowered it started, went healthy, and answered `200` on port 80.
So the reverse proxy — the thing most likely to be called a blocker — is one
line in `sysctl.conf`.

**`pi-hole` — starts, and does not work.** Two things, and only one of them was
predicted. Port 53 needs the same sysctl, lower still. After that it started —
which already contradicts the scan, because the scan calls NET_RAW a blocker
and the container got it: **capabilities inside a rootless container are
namespaced**, so NET_RAW applies to that container's own network namespace and
Docker grants it. What killed it was one line further down its own bootstrap:

```
[i] Gravity will now be run to create the database
[✗] DNS resolution is currently unavailable
```

It could not resolve outbound to build its blocklist, and went unhealthy. The
verdict stands, the stated reason was wrong, and that is the whole argument for
running the thing rather than reading the file.

## The cost nobody mentions

Removing the trial failed:

```
rm: cannot remove '.../linkding/db.sqlite3': Permission denied
```

Files an app writes under rootless belong to a subordinate uid — 100000 and up
— so the user who owns the daemon cannot read, move or delete them from a
shell. Cleaning up needs a container:

```
docker run --rm -v /path:/x alpine rm -rf /x/...
```

For Podhouse this is the real problem, bigger than any of the eight modules.
The whole design assumes `/opt/podhouse` belongs to the box's user and that
both the CLI and the dashboard can work with what the apps write — backups
read it, restore writes it, `setup.sh` seeds it. Under rootless, every one of
those paths would have to go through a container. That is not a port number; it
is a different shape.

## If you want to try it anyway

```
sudo apt-get install -y uidmap
dockerd-rootless-setuptool.sh install
export DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock
echo 'net.ipv4.ip_unprivileged_port_start=80' | sudo tee -a /etc/sysctl.conf
```

It installs alongside the root daemon rather than replacing it, which is how
the measurements above were taken without disturbing a running box.

## Where this leaves the socket question

Rootless would not have been a substitute for the split done in 0.15.0, and
the reverse is also true. They fix different halves: rootless bounds what the
daemon itself can do to the machine, and the split bounds what the *web
process* can ask the daemon for. See `docs/DOCKER-SOCKET.md`.
