#!/usr/bin/env bash
# Runs Seti in the foreground with the settings in SETI_HOME/seti.env; the installed units use it.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="${SETI_HOME:-${HOME}/.seti}/seti.env"
args=()
if [[ -f $env_file ]]; then
  args+=("--env-file=${env_file}")
fi

cd "${root}/server"
exec "${root}/server/node_modules/.bin/tsx" ${args[@]+"${args[@]}"} src/index.ts
