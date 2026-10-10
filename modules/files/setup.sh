#!/usr/bin/env bash
# File Browser's config, in the shape FileBrowser Quantum 2.x reads.
#
# 2.0.0 reads its config strictly and changed its layout, so a box that had
# 1.x needs three things done to config.yaml before 2.x will start at all:
#
#   - the listening port and base URL moved from `server:` to a top-level
#     `http:` block ("unknown field port" otherwise);
#   - `userDefaults:` in its 1.x form is rejected, and file permissions are now
#     per source, not per account — so the block goes, and defaults are managed
#     in the app (existing users keep theirs: the database migration copies them);
#   - the database is SQLite now. The old BoltDB file is imported on the first
#     start when `server.database.migrateFrom` names it — and 2.x REFUSES to
#     start if that line names a file that does not exist, so it is written
#     only while there is an old database and no new one, and taken out again
#     once the new one is there.
#
# The old database file is never removed: it stays beside the new one, and is
# the way back.
#
# Run by `homebox install files`, and by migrations/0.29.0. Safe to re-run:
# every step tests for its own end state first.
set -euo pipefail

HB_ROOT="${HB_ROOT:-/opt/podhouse}"
CONFIG_DIR="$HB_ROOT/modules/files/config/filebrowser"
CONFIG="$CONFIG_DIR/config.yaml"
OLD_DB="$CONFIG_DIR/data/filebrowser.db"
NEW_DB="$CONFIG_DIR/data/filebrowser.sqlite"
# Paths as the container sees them.
IN_NEW="/home/filebrowser/data/filebrowser.sqlite"
IN_OLD="/home/filebrowser/data/filebrowser.db"

mkdir -p "$CONFIG_DIR/data"

own() {
  # The container runs as PUID:PGID, and a bind directory created here (or by
  # Docker) belongs to root. File Browser then dies on its first start with
  # "could not open database: permission denied" and restarts forever.
  chown -R "${PUID:-1000}:${PGID:-1000}" "$CONFIG_DIR" 2>/dev/null || true
}

needs_import() { [ -s "$OLD_DB" ] && [ ! -s "$NEW_DB" ]; }

if [ ! -f "$CONFIG" ]; then
  {
    cat <<YAML
http:
  port: 80
  baseURL: "/"
server:
  database:
    path: "$IN_NEW"
YAML
    if needs_import; then printf '    migrateFrom: "%s"\n' "$IN_OLD"; fi
    cat <<'YAML'
  # /folder is the whole Podhouse data pool, bind-mounted by the compose file.
  sources:
    - path: "/folder"
      name: "Podhouse"
      config:
        defaultEnabled: true
        createUserDir: false
auth:
  adminUsername: admin
  methods:
    password:
      enabled: true
      minLength: 8
YAML
  } > "$CONFIG"
  own
  echo "files: wrote $CONFIG"
  exit 0
fi

if ! grep -q '^http:' "$CONFIG"; then
  # A 1.x config. Keep it beside the new one, then rewrite: the port and base
  # URL it had go to `http:`, `userDefaults:` is dropped, the database block
  # is added. Everything else — the sources, auth, anything added by hand —
  # is carried over line for line.
  cp -p "$CONFIG" "$CONFIG_DIR/config.v1.yaml"
  import=0; needs_import && import=1
  awk -v newdb="$IN_NEW" -v olddb="$IN_OLD" -v import="$import" '
    /^userDefaults:/        { skip = 1; next }
    skip && /^[^ \t#]/      { skip = 0 }
    skip                    { next }
    /^[^ \t#]/              { top = $0 }
    top ~ /^server:/ && /^  port:/    { sub(/^  port:[ \t]*/, "");    port = $0; next }
    top ~ /^server:/ && /^  baseURL:/ { sub(/^  baseURL:[ \t]*/, ""); base = $0; next }
    { line[n++] = $0 }
    END {
      print "http:"
      print "  port: " (port != "" ? port : "80")
      print "  baseURL: " (base != "" ? base : "\"/\"")
      for (i = 0; i < n; i++) {
        print line[i]
        if (line[i] ~ /^server:/) {
          print "  database:"
          print "    path: \"" newdb "\""
          if (import == 1) print "    migrateFrom: \"" olddb "\""
        }
      }
    }' "$CONFIG_DIR/config.v1.yaml" > "$CONFIG.new"
  mv "$CONFIG.new" "$CONFIG"
  own
  echo "files: converted config.yaml for File Browser 2.x (the 1.x file is kept as config.v1.yaml)"
  exit 0
fi

# Already a 2.x config. The import line has done its job once the new
# database exists, and from then on it is only a way to fail: remove it.
if grep -q '^    migrateFrom:' "$CONFIG" && [ -s "$NEW_DB" ]; then
  sed -i '/^    migrateFrom:/d' "$CONFIG"
  own
  echo "files: the old database has been imported; removed migrateFrom from config.yaml"
  exit 0
fi

own
echo "files: config.yaml already in the 2.x shape, leaving it alone"
