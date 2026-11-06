#!/usr/bin/env bash
# Starts a private PostgreSQL on the tmpfs, then the demo in its place; both end with the container.
set -euo pipefail

pgdata=/data/postgres
sockets=/data/run
mkdir -p "$sockets"
initdb --pgdata="$pgdata" --username=demo --auth=trust --encoding=UTF8 --no-instructions >/dev/null
pg_ctl --pgdata="$pgdata" --log=/data/postgres.log --wait start \
  -o "-c listen_addresses='' -c unix_socket_directories=$sockets -c shared_buffers=32MB -c max_connections=40"

cd /app/server
exec node dist/main.js
