#!/usr/bin/env bash
# Runs the public demo on this machine: a fresh data folder and database on every start and reset.
set -euo pipefail

server="$(cd "$(dirname "${BASH_SOURCE[0]}")/../server" && pwd)"
port="${SETI_DEMO_PORT:-3016}"
database="${SETI_DEMO_DATABASE_URL:-postgresql:///seti_demo?host=/var/run/postgresql}"

cd "$server"
while true; do
  data="$(mktemp -d "${TMPDIR:-/tmp}/seti-demo-XXXXXX")"
  echo "seti demo: data in $data, open http://localhost:$port"
  env -u SETI_PUBLIC_URL SETI_DEMO=1 SETI_HOME="$data" SETI_HOST=127.0.0.1 SETI_PORT="$port" \
    SETI_DATABASE_URL="$database" node dist/main.js
done
