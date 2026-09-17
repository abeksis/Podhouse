#!/usr/bin/env bash
# Seed the Portainer admin password file before its first start.
#
# Portainer's `--admin-password-file` reads plaintext from this path and
# creates the admin account at boot. Without it Portainer opens an
# unauthenticated setup screen for whoever reaches port 9000 first, and locks
# itself a few minutes later — leaving an install nobody can log into.
set -euo pipefail

HB_ROOT="${HB_ROOT:-/opt/podhouse}"
CONFIG_DIR="$HB_ROOT/modules/portainer/config"
PASSWORD_FILE="$CONFIG_DIR/portainer-admin-password"

mkdir -p "$CONFIG_DIR/portainer"

if [ -f "$PASSWORD_FILE" ]; then
  echo "portainer: password file already present, leaving it alone"
  exit 0
fi

# Generated when this module is installed and kept in .env, so
# `homebox secrets portainer` and the actual login agree.
PASSWORD="${PORTAINER_ADMIN_PASSWORD:-}"
if [ -z "$PASSWORD" ]; then
  PASSWORD="$(grep -E '^PORTAINER_ADMIN_PASSWORD=' "$HB_ROOT/.env" 2>/dev/null | cut -d= -f2-)"
fi
if [ -z "$PASSWORD" ]; then
  echo "portainer: PORTAINER_ADMIN_PASSWORD is not in .env" >&2
  exit 1
fi

# Portainer rejects anything under 12 characters and would exit on boot.
if [ "${#PASSWORD}" -lt 12 ]; then
  echo "portainer: PORTAINER_ADMIN_PASSWORD is shorter than the 12 characters Portainer requires" >&2
  exit 1
fi

# No trailing newline: Portainer takes the file's bytes verbatim, and a
# newline becomes part of the password you then cannot type.
printf '%s' "$PASSWORD" > "$PASSWORD_FILE"
chmod 600 "$PASSWORD_FILE"

echo "portainer: wrote $PASSWORD_FILE"
