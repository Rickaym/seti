#!/usr/bin/env bash
# Upgrades this Seti clone: pull, install, build, back up the database, restart, check, roll back.
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/upgrade.sh [--ref <ref>] [--no-backup] [--no-restart] [--force]

Fetches the new version, installs and builds it, dumps the database to SETI_HOME/pg-dumps
(keeping the newest 10), restarts seti.service and seti-ea.service when they run, and waits for
the health check. Seti applies database migrations itself when it starts. When the build or the
health check fails, it puts the previous version back and says how to restore the dump.

Options:
  --ref <ref>    what to upgrade to (default origin/main)
  --no-backup    skip the database dump
  --no-restart   install and build only; restart Seti yourself
  --force        upgrade even with local changes, or rebuild when already up to date
  -h, --help     show this help
USAGE
}

# shellcheck source=scripts/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

REF=origin/main
BACKUP=1
RESTART=1
FORCE=0
while [[ $# -gt 0 ]]; do
  case $1 in
    --ref) REF=$2; shift ;;
    --no-backup) BACKUP=0 ;;
    --no-restart) RESTART=0 ;;
    --force) FORCE=1 ;;
    -h | --help) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

DUMP_DIR="${SETI_HOME_DIR}/pg-dumps"
DUMPS_KEPT=10
cd "$SETI_ROOT"

use_node || die "Seti needs Node.js ${NODE_MAJOR}." 'scripts/install.sh sets it up'
have pnpm || die 'pnpm is not on PATH.' 'corepack enable pnpm'

# Moves the checkout to a commit: fast-forwards a branch, or moves a detached HEAD.
move_to() {
  if git symbolic-ref -q HEAD >/dev/null; then
    git merge --quiet --ff-only "$1"
  else
    git checkout --quiet --detach "$1"
  fi
}

ea_in_use() { unit_enabled seti-ea.service || [[ -d ea/.venv ]]; }

install_and_build() {
  local log="${SETI_HOME_DIR}/upgrade.log"
  if ! { pnpm install --frozen-lockfile && pnpm build; } >"$log" 2>&1; then
    tail -n 30 "$log" >&2
    warn "pnpm install or pnpm build failed; the full output is in ${log}"
    return 1
  fi
  if ea_in_use; then
    uv sync --project ea --locked --quiet || return 1
  fi
}

# Rewrites the units the installer wrote, so they follow changes to deploy/; leaves others alone.
refresh_units() {
  local unit refreshed=0
  systemd_user || return 0
  for unit in seti.service seti-ea.service; do
    if unit_ours "$unit"; then
      render_unit "$unit" >/dev/null
      refreshed=1
    fi
  done
  [[ $refreshed -eq 0 ]] || systemctl --user daemon-reload
}

restart_units() {
  local units=()
  unit_enabled seti.service && units+=(seti.service)
  unit_enabled seti-ea.service && units+=(seti-ea.service)
  if [[ ${#units[@]} -eq 0 ]]; then
    return 1
  fi
  systemctl --user restart "${units[@]}"
}

# Puts the previous commit back, rebuilds it, and restarts it when Seti was restarted.
roll_back() {
  local reason=$1
  warn "${reason}; rolling back to ${PREVIOUS:0:12}"
  git checkout --quiet --detach "$PREVIOUS"
  if [[ -n $BRANCH ]]; then
    git checkout --quiet -B "$BRANCH" "$PREVIOUS"
  fi
  install_and_build || die 'The previous version did not build either.' 'pnpm install && pnpm build'
  refresh_units
  if [[ $RESTARTED -eq 1 ]]; then
    restart_units
    health_check 180 >/dev/null || warn 'the previous version is not healthy either: see pnpm run doctor'
  fi
  local lines=("Seti runs ${PREVIOUS:0:12} again.")
  if [[ -n $DUMP ]]; then
    lines+=("If the new version changed the database, stop Seti and restore the dump taken first:"
      "pg_restore --clean --if-exists --no-owner -d '$(database_url)' ${DUMP}")
  fi
  die "Upgrade to ${TARGET:0:12} failed." "${lines[@]}"
}

fetch_target() {
  step 'Fetching'
  if [[ $FORCE -eq 0 ]] && ! { git diff --quiet && git diff --cached --quiet; }; then
    die 'This checkout has local changes.' 'commit or stash them, or pass --force'
  fi
  PREVIOUS="$(git rev-parse HEAD)"
  BRANCH="$(git symbolic-ref -q --short HEAD || true)"
  git fetch --quiet origin
  TARGET="$(git rev-parse "${REF}^{commit}")"
  if [[ $TARGET == "$PREVIOUS" && $FORCE -eq 0 ]]; then
    ok "already at ${TARGET:0:12}"
    exit 0
  fi
  if [[ $TARGET != "$PREVIOUS" ]] && ! git merge-base --is-ancestor "$PREVIOUS" "$TARGET"; then
    [[ $FORCE -eq 1 ]] || die "${REF} does not contain the running commit ${PREVIOUS:0:12}." \
      'pass --force to move to it anyway'
  fi
  ok "${PREVIOUS:0:12} -> ${TARGET:0:12}"
}

backup() {
  step 'Backing up the database'
  local url
  url="$(database_url)"
  have pg_dump || roll_back 'pg_dump is missing (sudo apt-get install postgresql-client, or pass --no-backup)'
  (umask 077 && mkdir -p "$DUMP_DIR")
  DUMP="${DUMP_DIR}/seti-$(date -u +%Y%m%dT%H%M%SZ)-${PREVIOUS:0:12}.pgdump"
  if (umask 077 && pg_dump -Fc -d "$url" -f "$DUMP" 2>/dev/null); then
    ok "dumped to ${DUMP}"
    find "$DUMP_DIR" -maxdepth 1 -name 'seti-*-*.pgdump' -type f | sort -r | tail -n "+$((DUMPS_KEPT + 1))" |
      while IFS= read -r old; do rm -f -- "$old"; done
    return 0
  fi
  rm -f -- "$DUMP"
  DUMP=''
  if (cd / && psql -XAtq -d "$url" -c 'SELECT 1' >/dev/null 2>&1); then
    roll_back 'pg_dump could not dump the database'
  fi
  note 'no database yet; nothing to back up'
}

main() {
  fetch_target
  RESTARTED=0
  DUMP=''
  step 'Installing and building'
  move_to "$TARGET" || git checkout --quiet --detach "$TARGET"
  install_and_build || roll_back 'the build failed'
  ok 'built'
  refresh_units
  [[ $BACKUP -eq 0 ]] || backup
  if [[ $RESTART -eq 0 ]]; then
    ok "built ${TARGET:0:12}; restart Seti to run it"
    return 0
  fi
  step 'Restarting'
  if restart_units; then
    RESTARTED=1
    health_check 180 || roll_back 'the health check failed'
    ok "Seti runs ${TARGET:0:12}"
  else
    ok "built ${TARGET:0:12}; no systemd unit runs Seti here, so restart scripts/start.sh yourself"
  fi
}

main
