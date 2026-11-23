#!/usr/bin/env bash
# Runs Seti in the foreground with the settings in SETI_HOME/seti.env; the installed units use it.
# `start.sh node` runs the node of a split Seti instead, and records its build for upgrades.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="${SETI_HOME:-${HOME}/.seti}/seti.env"
args=()
if [[ -f $env_file ]]; then
  args+=("--env-file=${env_file}")
fi

entry=src/index.ts
if [[ ${1:-} == node ]]; then
  # shellcheck source=scripts/lib.sh
  source "${root}/scripts/lib.sh"
  run_dir="${SETI_HOME:-${HOME}/.seti}/run"
  mkdir -p -m 700 "$run_dir"
  SETI_BUILD_ID="$(node_build_id "$root")"
  export SETI_BUILD_ID
  printf '%s\n' "$SETI_BUILD_ID" >"${run_dir}/node.build"
  entry=src/node/main.ts
fi

cd "${root}/server"
exec "${root}/server/node_modules/.bin/tsx" ${args[@]+"${args[@]}"} "$entry"
