# Security notes

## The dashboard can create and destroy containers

This is the thing to understand before anything else. Installing an app means
creating containers, and write access to the Docker socket is root on this box:
it can start a privileged container that mounts the host filesystem.

Since 0.15.0 the web process does not hold it. It runs with no socket at all
and asks a second container, `dashboard-worker`, for named operations —
`install radarr`, `stop jellyfin`, `platform.selfUpdate 0.15.0` — over a unix
socket in `state/`. The worker builds every command itself from an id it
validates against the catalog on disk. Reads go to a proxy that answers GET
and refuses POST outright.

So a session on this page can install, remove and restart apps. It is no
longer root on the machine. `docs/DOCKER-SOCKET.md` has the inventory, the
reasoning, and what this still does not fix.

The dashboard has a login. On first run it shows a one-time bootstrap token
printed by the installer; you paste it, choose a password, and that claims the
box. From then on every route except the login screen itself needs a session.

Passwords are scrypt (N=16384, r=8, p=1) with a per-account salt, compared with
`timingSafeEqual`. Sessions are 32 random bytes held server-side in
`state/auth.json`, carried in an HttpOnly, SameSite=Lax cookie, and dropped
entirely when the password changes. Failed attempts are rate limited per
address: eight in fifteen minutes and that address waits.

The cookie is only marked `Secure` when the request arrived over HTTPS. On a
plain-HTTP LAN a Secure cookie is never sent, so setting it unconditionally
would mean nobody could log in at all — the flag appears automatically behind
a TLS proxy, which is the case where it does something.

Lost the password? There is no reset by email, because there is no email.
`sudo rm /opt/podhouse/state/auth.json` on the server unclaims the box, then
`homebox bootstrap-token` prints a fresh token. That requires shell access,
which is the right bar for it.

That is an acceptable trade on a trusted LAN and nothing more. Before putting
it behind a proxy, on a hostname, or anywhere reachable from outside, put a
real auth layer in front of it. **Putting it behind the proxy does not add
authentication** — it only makes the same unauthenticated page easier to find.

Portainer holds the same socket with the same consequences. Since 0.9.0 it is
not installed on a new box — it is an app in the store, chosen deliberately or
not at all. A box that had it before keeps it.

**docs/DOCKER-SOCKET.md** lists every Docker call this dashboard makes, who
else on the box holds the socket, and what a filtered proxy can and cannot fix
— including why putting one in front of the dashboard as it is built today
would be decoration rather than a mitigation.

**Nginx Proxy Manager's admin UI on port 81 is the third key to this box.**
Whoever reaches it can point any hostname at anything, including a service
that was never meant to be public. Treat 80 and 443 as the public surface and
81 as strictly internal.

An outside review of this project, and what was done about each of its
findings, is in docs/SECURITY-REVIEW.md.

## Two halves of a session

The session cookie is host-only, and cookies do not know about ports: the apps
this box installs sit on other ports of the SAME hostname, so visiting one of
them sends it the dashboard's cookie. HttpOnly keeps a cookie away from scripts;
it does not hide it from the server receiving it.

So the cookie alone no longer authorises a change. Every request that modifies
anything must also carry `x-hb-token`, a second secret returned only in the
login response and kept in this origin's localStorage — which an app on another
port cannot read and is never handed. A stolen cookie can read the Overview; it
cannot install, remove, restore or change the password.

Sessions created before this existed have no token and are refused for writes,
which sends that browser to the login screen once.

## Releases are signed

Releases are annotated git tags, signed with an SSH key (`gpg.format = ssh`).
The public half is published in the repository at `releases/signers/podhouse.pub`,
and each box keeps its own copy at `state/release-signer.pub`.

`scripts/self-update.sh` checks the signature after fetching the tag and before
anything is written to disk, and refuses a tag that does not verify against the
**pinned** file. It deliberately does not read the key out of the tree being
installed: a repository that can hand you the code can hand you the key that
vouches for it, so that check would be a signature verified against itself.

The check reads `git verify-tag`'s **exit status**, not its output. For a valid
signature by a key that is not allowed, git prints "Good signature" and adds
"No principal matched" — matching on the text would pass the exact case the
check exists to stop. Measured: correct key 0, wrong key 1, unsigned tag 1,
missing signers file 1.

Pinning happens once. A fresh install pins from the clone; a box that predates
signing pins at the end of its next successful update, and requires a signature
from the one after that. The key is never overwritten by a release, because a
key a release can rewrite is not a pinned key.

The private half lives on the maintainer's machine and is not in this
repository. Losing it means publishing a new key and asking every box to
re-pin by hand; there is no revocation list.

## What is still open

- **The first update is unverified.** Release signing exists (see below), but a
  box has to learn the key from somewhere, and it learns it from the tree it
  installed. Whoever served that first clone is trusted exactly once. Every
  update after it is checked against the pinned key. There is no way around
  this without shipping the key by a second channel the box can already trust.
- **Cross-process auth writes.** Auth changes inside the dashboard are
  serialised, so a login cannot restore a password that was just changed. The
  CLI writes the same file and is not part of that queue; two writers at the
  same instant can still lose one of the changes.
- **LAN-only is an assumption.** The dashboard binds 8443 on every interface
  and the deployment is expected to keep it on a private network. Nothing in
  the process enforces that.

## What is deliberately narrowed

- **Purge is a separate verb from uninstall.** `remove` deletes containers
  and keeps `modules/<id>/config`; `purge` deletes that directory too, and
  the UI makes you type the module name first.
- **Compose runs with argv, never a shell string.** Module ids are validated
  against `^[a-z0-9][a-z0-9-]{0,39}$` before they reach a path or a project
  name, and `spawn` is called with an argument array, so even a bad id cannot
  become shell syntax.
- **Required modules cannot be stopped from the UI.** Stopping the proxy or
  the dashboard from the dashboard is how you lose the page you are clicking
  in, so `core` and `dashboard` reject stop and remove.
- **One operation per module at a time.** Two overlapping `compose up` runs on
  the same project fight over the same containers and leave one half-created.
- **`--purge` is separate from `--yes` in the CLI too**, for the same reason.

## Secrets

`.env` is mode 600, owned by the `homebox` user, and holds every generated
password and encryption key. It is **not** in git — `.gitignore` covers it.

- Modules reference `${NAME}` and never contain a value.
- `x-homebox.env_vars` lists the *names* a module needs. The dashboard shows
  those names; it never reads `.env`.
- `homebox secrets <module>` prints values only when asked, so they do not end
  up in `list` or `info` output that gets pasted into a chat.
- `install.sh` never regenerates a secret that already exists. An encryption
  key that changes (n8n's, for instance) turns every stored credential into
  unreadable bytes.

Read access to the Docker socket also exposes every container's environment
block. Treat anything that can read the socket as holding the same secrets as
`docker inspect`.

## The raw config editor

Settings → Configuration → **Edit .env values** reads and writes `.env` over an
unauthenticated endpoint. That is the same trust boundary the rest of the
dashboard already has — anything that can install a container can do worse —
but it is worth naming:

- **Only declared keys are writable.** The schema in `lib/config.js` is the
  allowlist; a key not in it is returned read-only and rejected on save.
  "Write any variable name you like into .env" is a far bigger hole than
  "edit these thirty".
- **Values are validated for newlines.** One of them would let a single field
  smuggle in a second variable.
- **The file is edited in place**, line by line. Comments, ordering and keys
  this build does not know about all survive. Rewriting from a parsed object
  is how a config editor quietly eats things.
- **It is written 0600 and chowned back** to whoever owns the tree, because
  the dashboard container runs as root.
- Secrets render as password fields but their values *are* sent to the page.
  That is the difference between this and the Passwords tab: a listing has no
  reason to print a secret, an editor cannot work without one.

## Backups

An archive contains `.env`, which is every generated password on the box. So:

- **There is no unencrypted path.** With `HB_BACKUP_KEY` missing, `create`
  fails and says how to set one. It never falls back to plaintext.
- **AES-256-GCM**, key `scrypt`-derived from `HB_BACKUP_KEY`. On disk:
  `[16-byte IV][ciphertext][16-byte auth tag]`.
- **Every archive is verified before it counts.** It is written to a temp
  path, decrypted and authenticated in full, and only then renamed into
  place. An archive that cannot be decrypted is worse than no archive: it is
  an archive you believe in.
- **Revealing the key is a POST**, not a GET — a secret must not be reachable
  by a link, a prefetch, or anything that lands in browser history. It is
  still an unauthenticated endpoint on an unauthenticated page: whoever can
  open the dashboard can read the key and download the archives.
- **Restoring is four steps, never one click.** `homebox restore` still only
  unpacks into a new directory and touches nothing. Settings → Backups can now
  write an archive back, and keeps the same property by construction: the
  archive is decrypted and authenticated first, unpacked to `state/restore/<id>`
  outside the live tree, and READ — every app in it, how many files, and what
  each would write over. Nothing moves until a person ticks the individual
  apps (plus `.env` and Podhouse's own state as separate opt-ins) and types the
  word. Applying takes a backup first, stops only the apps it rewrites, moves
  what it replaces into `state/restore/<id>/replaced`, and starts them again.
  There is no "restore everything" button.
- **A restore can only write three kinds of path.** Module config directories,
  `state/`, and `.env`. Every entry in an archive is checked for an absolute
  path or a `..` before it is unpacked, because an archive is a file from
  somewhere else. `data/` — the media pool — is never restored from the page.
- **The decrypted copy is deleted** as soon as the restore finishes or the
  archive is discarded; while it exists it is 0600 inside a 0700 directory.
  What was replaced stays until you discard it, as the way back.
- Archives land on the same filesystem they protect, which covers a mistake
  but not a dead disk or a deleted folder. Set `HB_BACKUP_COPY_DIR` (Settings →
  Configuration → Backup) to a folder on another disk or a mounted NAS share,
  and every archive is copied there and compared byte for byte where it
  landed. The copy is refused, and the page says why, when that folder turns
  out to be on the box's own disk — which is what an unmounted share looks
  like.
- The dashboard never mounts that folder. The copy runs in a throwaway
  container with no network, no socket and no key, mounting the local backups
  read-only and the destination alone writable. A NAS that is down at boot
  costs one copy, not the dashboard.
- Copies stay encrypted. Whoever can read the NAS folder holds ciphertext; the
  key is still only in `.env`, so keep a copy of the key somewhere that is not
  this box either, or the archives on the NAS cannot be opened after the box
  is gone.

## Input handling

- `/api/logs` takes a container **name**, validates it against a strict
  pattern, then checks it against the live container list before use. A name
  that is not on the box is a 404, so nothing user-supplied reaches the
  Docker API path.
- Static file serving resolves the path and verifies the result is still
  inside `public/`, which stops encoded and decoded traversal alike.
- Every POST body is capped at 16KB and its values whitelisted.
- Everything rendered into the DOM goes through `escapeHtml`. Container names,
  image tags and log text are attacker-influenceable in principle and are
  never interpolated raw.

## The proxy

Routing lives in Nginx Proxy Manager's own database, configured through its
UI — there is no generated config file to review in git. Its admin account is
seeded at first boot from `NPM_ADMIN_PASSWORD` so the setup form is never left
open to whoever finds port 81 first.

A real hostname with real TLS is exactly the point at which the authentication
question above stops being optional.
