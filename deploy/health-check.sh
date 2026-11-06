#!/usr/bin/env bash
# Waits for Seti on loopback, then checks an authenticated call and the EA; never prints the token.
set -euo pipefail

BASE="${SETI_URL:-http://127.0.0.1:3006}"
TOKEN_FILE="${SETI_TOKEN_FILE:-${HOME}/.seti/credentials/local-token-user}"
WAIT_S="${1:-60}"

status() {
  curl -s -o /dev/null -w '%{http_code}' -H 'Host: seti.localhost:3006' "$@" || true
}

auth_config() {
  printf 'header = "Authorization: Bearer %s"\n' "$(tr -d '\n' <"$TOKEN_FILE")"
}

authed() {
  status -K <(auth_config) "${BASE}$1"
}

deadline=$((SECONDS + WAIT_S))
until [[ $(status "${BASE}/api/ping") == 204 ]]; do
  if ((SECONDS >= deadline)); then
    echo "Seti did not answer /api/ping within ${WAIT_S}s" >&2
    exit 1
  fi
  sleep 2
done
echo "ping: 204"

code=$(status "${BASE}/api/system")
[[ $code == 401 ]] || { echo "unauthenticated /api/system answered ${code}, expected 401" >&2; exit 1; }
echo "without token: 401"

code=$(authed /api/system)
[[ $code == 200 ]] || { echo "authenticated /api/system answered ${code}, expected 200" >&2; exit 1; }
echo "with token: 200"

echo "ea health: $(curl -s -H 'Host: seti.localhost:3006' -K <(auth_config) "${BASE}/api/ea/health")"
