#!/usr/bin/env bash
# 0.29.0 — carry File Browser from 1.x to 2.x.
#
# The files module now ships FileBrowser Quantum 2.0.0. 2.x reads a different
# config layout and a different database, and a 1.x box upgraded by its
# button alone crash-loops on "unknown field port" until the health gate puts
# 1.x back (which is what happened, and why this exists).
#
# So the move is made here, as one step, on a box that has File Browser:
#
#   1. modules/files/setup.sh rewrites config.yaml for 2.x (the 1.x file is
#      kept as config.v1.yaml) and names the old database for import;
#   2. a version pinned to 1.x from the Updates page is released — the pin is
#      what would hold the image at 1.x under a compose file written for 2.x;
#   3. the container is recreated, and this waits for it to be healthy;
#   4. once it is, the import line is taken out of the config again.
#
# The old database (data/filebrowser.db) is never removed: 2.x imports from it and
# writes a new file beside it.
#
# If 2.x does not come up, everything above is put back — the config, the pin,
# and the 1.x container from the compose file the box had before this update —
# and the migration fails, which aborts the Podhouse update and rolls it back.
# A box left on 1.x under a 2.x module would break on its next restart.
set -euo pipefail

HB_ROOT="${HB_ROOT:-/opt/podhouse}"
MOD="$HB_ROOT/modules/files"
CONF_DIR="$MOD/config/filebrowser"
PINS="$HB_ROOT/state/image-pins.json"
OVERRIDE="$HB_ROOT/state/overrides/files.yml"
ENV_FILE="$HB_ROOT/.env"
say() { printf '[migration 0.29.0] %s\n' "$*"; }

image="$(docker inspect -f '{{.Config.Image}}' filebrowser 2>/dev/null || true)"

# setup.sh needs PUID/PGID to hand the files to the right account.
run_setup() {
  local puid pgid
  puid="$(grep -E '^PUID=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- || true)"
  pgid="$(grep -E '^PGID=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- || true)"
  HB_ROOT="$HB_ROOT" PUID="${puid:-1000}" PGID="${pgid:-1000}" bash "$MOD/setup.sh"
}

if [ -z "$image" ]; then
  # Not installed. If a config from an earlier install is lying there, bring
  # it to the 2.x shape so a later install starts; otherwise nothing to do.
  if [ -f "$CONF_DIR/config.yaml" ]; then run_setup; else say "File Browser is not installed here"; fi
  exit 0
fi

case "$image" in
  gtstef/filebrowser:1.*) ;;
  *) say "File Browser is already on ${image#*:}; nothing to carry over"; run_setup >/dev/null 2>&1 || true; exit 0 ;;
esac

say "File Browser is on ${image#*:}; moving it to 2.x"

# ---- what to put back if 2.x does not start
SAVE="$(mktemp -d)"
cp -p "$CONF_DIR/config.yaml" "$SAVE/config.yaml"
[ -f "$PINS" ] && cp -p "$PINS" "$SAVE/image-pins.json"
[ -f "$OVERRIDE" ] && cp -p "$OVERRIDE" "$SAVE/files.yml"
# The compose file this box ran until a moment ago: the update has already
# checked the new tree out, so the old one comes from git.
git -C "$HB_ROOT" show 'HEAD@{1}:modules/files/docker-compose.yml' > "$SAVE/docker-compose.yml" 2>/dev/null || rm -f "$SAVE/docker-compose.yml"

compose_files() { # prints -f args for the files module, with the override when there is one
  printf -- '-f\n%s\n' "$1"
  if [ -f "$OVERRIDE" ]; then printf -- '-f\n%s\n' "$OVERRIDE"; fi
}
up_with() { # compose file
  local -a args=()
  while IFS= read -r a; do args+=("$a"); done < <(compose_files "$1")
  docker compose -p homebox-files "${args[@]}" --env-file "$ENV_FILE" up -d --remove-orphans >/dev/null 2>&1
}
healthy_within() { # seconds
  local waited=0 status
  while [ "$waited" -lt "$1" ]; do
    status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' filebrowser 2>/dev/null || echo gone)"
    [ "$status" = "healthy" ] && return 0
    sleep 5; waited=$((waited + 5))
  done
  return 1
}

put_back() {
  say "2.x did not come up — putting 1.x back"
  docker logs --tail 15 filebrowser 2>&1 | sed 's/^/    /' || true
  cp -p "$SAVE/config.yaml" "$CONF_DIR/config.yaml"
  rm -f "$CONF_DIR/data/filebrowser.sqlite" "$CONF_DIR/data/filebrowser.sqlite-shm" "$CONF_DIR/data/filebrowser.sqlite-wal"
  if [ -f "$SAVE/image-pins.json" ]; then cp -p "$SAVE/image-pins.json" "$PINS"; fi
  if [ -f "$SAVE/files.yml" ]; then mkdir -p "$(dirname "$OVERRIDE")"; cp -p "$SAVE/files.yml" "$OVERRIDE"; else rm -f "$OVERRIDE"; fi
  if [ -f "$SAVE/docker-compose.yml" ] && up_with "$SAVE/docker-compose.yml" && healthy_within 120; then
    say "File Browser is back on ${image#*:}, as it was"
  else
    say "WARNING: could not bring 1.x back by itself. After this update rolls back, run: sudo $HB_ROOT/homebox up files --yes"
  fi
  rm -rf "$SAVE"
}

# ---- 1. the config
run_setup

# ---- 2. release a 1.x pin
if [ -f "$PINS" ] && grep -q '"files/filebrowser"' "$PINS"; then
  node -e '
    const fs = require("fs");
    const file = process.argv[1];
    const pins = JSON.parse(fs.readFileSync(file, "utf8"));
    const pin = pins["files/filebrowser"];
    if (pin && /^1\./.test(String(pin.tag))) { delete pins["files/filebrowser"]; fs.writeFileSync(file, JSON.stringify(pins, null, 2) + "\n"); }
  ' "$PINS"
  # files has one service, so its override file held only this pin.
  if ! grep -q '"files/filebrowser"' "$PINS"; then rm -f "$OVERRIDE"; say "released the 1.x version pin"; fi
fi

# ---- 3. recreate on 2.x and wait
if ! up_with "$MOD/docker-compose.yml" || ! healthy_within 180; then
  put_back
  exit 1
fi

# ---- 4. the import is done
run_setup
rm -rf "$SAVE"
say "File Browser is on $(docker inspect -f '{{.Config.Image}}' filebrowser | cut -d: -f2); users, shares and settings were carried over, and the 1.x database is kept beside the new one"
