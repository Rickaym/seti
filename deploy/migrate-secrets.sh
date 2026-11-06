#!/usr/bin/env bash
# Moves secrets from ~/.seti/*.env into systemd credential files; prints names, never values.
set -euo pipefail
umask 077

SETI_DIR="${HOME}/.seti"
CRED_DIR="${SETI_DIR}/credentials"
UNIT_DIR="${XDG_CONFIG_HOME:-${HOME}/.config}/systemd/user"
DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNITS=(seti.service seti-ea.service cloudflared.service)

# Each entry is env-file:VARIABLE:credential-name.
MOVES=(
  "ea.env:DEEPGRAM_API_KEY:deepgram-api-key"
  "ea.env:OPENAI_API_KEY:openai-api-key"
  "ea.env:ELEVENLABS_API_KEY:elevenlabs-api-key"
  "ea.env:CLOUDFLARE_TURN_KEY_ID:cloudflare-turn-key-id"
  "ea.env:CLOUDFLARE_TURN_API_TOKEN:cloudflare-turn-api-token"
  "seti.env:OPENAI_API_KEY:openai-api-key"
  "cloudflared.env:TUNNEL_TOKEN:tunnel-token"
)
GENERATED=(secret-key local-token-user local-token-ea)
OPTIONAL=(openai-api-key deepgram-api-key elevenlabs-api-key cloudflare-turn-key-id cloudflare-turn-api-token)

usage() {
  cat <<'USAGE'
Usage: deploy/migrate-secrets.sh [--dry-run] [--no-units]
       deploy/migrate-secrets.sh --rollback ~/.seti/pre-credentials-<stamp>

Creates ~/.seti/credentials with one owner-only file per secret, moves the keys out of
~/.seti/ea.env, seti.env and cloudflared.env (backing the originals up first), generates the
secret store key and the local API tokens when missing, and installs the systemd units from
this directory. It never overwrites a credential that exists and never restarts a service.

--rollback puts back the env files and units from a backup directory this script made.
USAGE
}

say() { printf '%s\n' "$*"; }

# The last value VARIABLE has in an env file, unquoted; empty when absent.
env_value() {
  local file=$1 key=$2 line value=''
  [[ -r $file ]] || return 0
  while IFS= read -r line || [[ -n $line ]]; do
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line#export }"
    [[ $line =~ ^${key}[[:space:]]*= ]] || continue
    value="${line#*=}"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    if [[ ${#value} -ge 2 && ( ${value:0:1} == '"' || ${value:0:1} == "'" ) && ${value: -1} == "${value:0:1}" ]]; then
      value="${value:1:${#value}-2}"
    fi
  done <"$file"
  printf '%s' "$value"
}

# Removes the lines that assign VARIABLE from an env file, in place.
drop_key() {
  local file=$1 key=$2 tmp
  tmp="$(mktemp "${file}.XXXXXX")"
  grep -Ev "^[[:space:]]*(export[[:space:]]+)?${key}[[:space:]]*=" "$file" >"$tmp" || true
  mv "$tmp" "$file"
}

write_credential() {
  local name=$1 value=$2
  printf '%s\n' "$value" >"${CRED_DIR}/${name}"
  chmod 0600 "${CRED_DIR}/${name}"
}

rollback() {
  local backup=$1 name
  [[ -d $backup ]] || { say "No such backup directory: $backup" >&2; exit 1; }
  for name in ea.env seti.env cloudflared.env; do
    if [[ -f "${backup}/${name}" ]]; then
      cp -p "${backup}/${name}" "${SETI_DIR}/${name}"
      say "restored ${SETI_DIR}/${name}"
    fi
  done
  for name in "${UNITS[@]}"; do
    if [[ -f "${backup}/units/${name}" ]]; then
      cp -p "${backup}/units/${name}" "${UNIT_DIR}/${name}"
      say "restored ${UNIT_DIR}/${name}"
    fi
  done
  systemctl --user daemon-reload
  say "Units reloaded. Check out the previous Seti commit, then restart seti, seti-ea and cloudflared."
  say "The credential files in ${CRED_DIR} stay; delete them once the rollback is final."
}

DRY_RUN=0
INSTALL_UNITS=1
while [[ $# -gt 0 ]]; do
  case $1 in
    --dry-run) DRY_RUN=1 ;;
    --no-units) INSTALL_UNITS=0 ;;
    --rollback)
      [[ $# -ge 2 ]] || { usage >&2; exit 2; }
      rollback "$2"
      exit 0
      ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
  shift
done

[[ -d $SETI_DIR ]] || { say "No ${SETI_DIR}; nothing to migrate." >&2; exit 1; }

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP="${SETI_DIR}/pre-credentials-${STAMP}"

if [[ $DRY_RUN -eq 1 ]]; then
  say "Dry run: nothing is written."
fi

run() { [[ $DRY_RUN -eq 1 ]] || "$@"; }

run mkdir -p "$CRED_DIR" "${BACKUP}/units"
run chmod 0700 "$CRED_DIR" "$BACKUP"

for name in ea.env seti.env cloudflared.env; do
  if [[ -f "${SETI_DIR}/${name}" ]]; then
    run cp -p "${SETI_DIR}/${name}" "${BACKUP}/${name}"
  fi
done

declare -A MOVED=()
for entry in "${MOVES[@]}"; do
  IFS=: read -r file key name <<<"$entry"
  path="${SETI_DIR}/${file}"
  value="$(env_value "$path" "$key")"
  [[ -n $value ]] || continue
  if [[ -s "${CRED_DIR}/${name}" || -n ${MOVED[$name]:-} ]]; then
    say "kept      ${CRED_DIR}/${name} (exists); dropping ${key} from ${file}"
  else
    say "moved     ${key} from ${file} to ${CRED_DIR}/${name}"
    run write_credential "$name" "$value"
    MOVED[$name]=1
  fi
  run drop_key "$path" "$key"
done
unset value

for name in "${GENERATED[@]}"; do
  if [[ -s "${CRED_DIR}/${name}" ]]; then
    say "kept      ${CRED_DIR}/${name}"
    continue
  fi
  say "generated ${CRED_DIR}/${name}"
  if [[ $name == secret-key ]]; then
    run write_credential "$name" "$(head -c 32 /dev/urandom | base64 -w0)"
  else
    run write_credential "$name" "$(head -c 32 /dev/urandom | base64 -w0 | tr '+/' '-_' | tr -d '=')"
  fi
done

for name in "${OPTIONAL[@]}" tunnel-token; do
  if [[ ! -e "${CRED_DIR}/${name}" ]]; then
    say "empty     ${CRED_DIR}/${name} (not set anywhere; fill it in to use it)"
    run write_credential "$name" ''
  fi
done

if [[ -f "${SETI_DIR}/cloudflared.env" ]] && ! grep -Eq '^[[:space:]]*[^#[:space:]]' "${SETI_DIR}/cloudflared.env"; then
  say "removed   ${SETI_DIR}/cloudflared.env (empty; the tunnel reads its token file)"
  run rm "${SETI_DIR}/cloudflared.env"
fi

if [[ $INSTALL_UNITS -eq 1 ]]; then
  run mkdir -p "$UNIT_DIR"
  for unit in "${UNITS[@]}"; do
    if [[ -f "${UNIT_DIR}/${unit}" ]]; then
      run cp -p "${UNIT_DIR}/${unit}" "${BACKUP}/units/${unit}"
    fi
    say "installed ${UNIT_DIR}/${unit}"
    run install -m 0644 "${DEPLOY_DIR}/${unit}" "${UNIT_DIR}/${unit}"
  done
  run systemctl --user daemon-reload
fi

FIRST_BACKUP="$(find "$SETI_DIR" -maxdepth 1 -type d -name 'pre-credentials-*' | sort | head -n 1)"
FIRST_BACKUP="${FIRST_BACKUP:-$BACKUP}"

say ""
say "Backup of the env files and units from before the first run: ${FIRST_BACKUP}"
say "Next: restart seti.service, then seti-ea.service and cloudflared.service, and check each."
if [[ -f "${SETI_DIR}/agent.env" ]]; then
  say "Seti imports GH_TOKEN from ${SETI_DIR}/agent.env into its secret store on its next start;"
  say "delete agent.env once Settings, Credential sets shows the GitHub token as imported."
fi
say "Rollback: $0 --rollback ${FIRST_BACKUP}"
