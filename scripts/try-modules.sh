#!/usr/bin/env bash
# Install modules one by one on a throwaway box, see what they actually do,
# then remove them.
#
#   sudo scripts/try-modules.sh monitoring files passwords
#   PRUNE=1 sudo scripts/try-modules.sh $(ls /opt/podhouse/modules)  # all of them
#
# For each module it prints one line:
#
#   RESULT files   waited=10s states=filebrowser:running  perm=clean
#
# states is every container of that module and what it ended up doing, and
# perm counts log lines that read like an operation the container was not
# allowed to perform. A container that says `restarting` is looping.
#
# This is how the capability lists in docs/MODULE-SCHEMA.md were established:
# drop everything, install, read what broke, give back exactly that. It is
# also what found three apps that had never started on a clean install — the
# kind of thing no amount of reading compose files reveals.
#
# RUN IT ON A BOX YOU CAN LOSE. It installs, purges and (with PRUNE=1) deletes
# every image not in use. Never on a box with data on it.
set -u

HB_ROOT="${HB_ROOT:-/opt/podhouse}"
cd "$HB_ROOT" || { echo "no install at $HB_ROOT"; exit 1; }

SETTLE="${SETTLE:-40}"   # seconds to watch a module after its containers exist
WAIT="${WAIT:-90}"       # seconds to wait for containers to exist at all
PRUNE="${PRUNE:-0}"      # delete unused images between modules

containers_of() {
  docker ps -a --filter "label=com.docker.compose.project=homebox-$1" --format '{{.Names}}'
}

for id in "$@"; do
  printf '\n===== %s (%s) =====\n' "$id" "$(date +%H:%M:%S)"

  if ! ./homebox install "$id" --yes >"/tmp/try-$id.log" 2>&1; then
    printf 'RESULT %-16s install-failed | %s\n' "$id" "$(tail -3 "/tmp/try-$id.log" | tr '\n' ' ')"
    ./homebox remove "$id" --yes --purge >/dev/null 2>&1
    continue
  fi

  waited=0
  while [ -z "$(containers_of "$id")" ] && [ "$waited" -lt "$WAIT" ]; do
    sleep 5; waited=$((waited + 5))
  done
  sleep "$SETTLE"

  states="$(docker ps -a --filter "label=com.docker.compose.project=homebox-$id" \
    --format '{{.Names}}:{{.State}}' | tr '\n' ' ')"
  perm=""
  for c in $(containers_of "$id"); do
    hits="$(docker logs "$c" 2>&1 | grep -ciE "operation not permitted|permission denied|EPERM" || true)"
    [ "$hits" != "0" ] && perm="$perm $c($hits)"
  done
  printf 'RESULT %-16s waited=%ss states=%s perm=%s\n' "$id" "$waited" "${states:-none}" "${perm:-clean}"

  ./homebox remove "$id" --yes --purge >/dev/null 2>&1
  [ "$PRUNE" = "1" ] && docker image prune -af >/dev/null 2>&1
done

printf '\nDONE\n'
