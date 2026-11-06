# shellcheck shell=bash
# Shared helpers of scripts/install.sh and scripts/upgrade.sh; bash 3.2 compatible for macOS.

SETI_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SETI_HOME_DIR="${SETI_HOME:-${HOME}/.seti}"
NODE_MAJOR=24
export NVM_VERSION=v0.40.4
export npm_config_update_notifier=false COREPACK_ENABLE_DOWNLOAD_PROMPT=0
export PATH="${HOME}/.local/bin:${PATH}"

if [[ -t 1 ]]; then
  C_BOLD=$'\033[1m' C_GREEN=$'\033[32m' C_YELLOW=$'\033[33m' C_RED=$'\033[31m' C_OFF=$'\033[0m'
else
  C_BOLD='' C_GREEN='' C_YELLOW='' C_RED='' C_OFF=''
fi

step() { printf '\n%s==> %s%s\n' "$C_BOLD" "$*" "$C_OFF"; }
ok() { printf '  %sok%s    %s\n' "$C_GREEN" "$C_OFF" "$*"; }
note() { printf '        %s\n' "$*"; }
warn() { printf '  %swarn%s  %s\n' "$C_YELLOW" "$C_OFF" "$*" >&2; }
die() {
  printf '  %sFAIL%s  %s\n' "$C_RED" "$C_OFF" "$1" >&2
  shift
  local line
  for line in "$@"; do
    printf '        %s\n' "$line" >&2
  done
  exit 1
}

have() { command -v "$1" >/dev/null 2>&1; }

# The last value a variable has in an env file, unquoted; empty when absent.
env_value() {
  local file=$1 key=$2 line value=''
  [[ -r $file ]] || return 0
  while IFS= read -r line || [[ -n $line ]]; do
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line#export }"
    case $line in
      "${key}="*) value="${line#*=}" ;;
      *) continue ;;
    esac
    if [[ ${#value} -ge 2 && (${value:0:1} == '"' || ${value:0:1} == "'") ]]; then
      value="${value:1:${#value}-2}"
    fi
  done <"$file"
  printf '%s' "$value"
}

# The setting from the environment, else from SETI_HOME/seti.env.
setting() {
  local key=$1 current
  eval "current=\${${key}:-}"
  if [[ -n $current ]]; then
    printf '%s' "$current"
  else
    env_value "${SETI_HOME_DIR}/seti.env" "$key"
  fi
}

node_major() {
  local version
  version="$(node --version 2>/dev/null || true)"
  version="${version#v}"
  printf '%s' "${version%%.*}"
}

# Puts Node 24 on PATH: one already there, else nvm's; returns 1 when neither has it.
use_node() {
  local major
  major="$(node_major)"
  if [[ -n $major && $major -ge $NODE_MAJOR ]]; then
    return 0
  fi
  if [[ -s "${NVM_DIR:-${HOME}/.nvm}/nvm.sh" ]]; then
    set +eu
    # shellcheck disable=SC1091
    . "${NVM_DIR:-${HOME}/.nvm}/nvm.sh" >/dev/null
    nvm use "$NODE_MAJOR" >/dev/null 2>&1
    set -eu
    major="$(node_major)"
    [[ -n $major && $major -ge $NODE_MAJOR ]] && return 0
  fi
  return 1
}

# The PostgreSQL database Seti uses, as the server computes it in server/src/config.ts.
database_url() {
  local url home
  url="$(setting SETI_DATABASE_URL)"
  if [[ -n $url ]]; then
    printf '%s' "$url"
    return
  fi
  home="${SETI_HOME_DIR%/}"
  [[ $home == /* ]] || home="${PWD}/${home}"
  if [[ $home == "${HOME}/.seti" ]]; then
    printf 'postgresql:///seti?host=/var/run/postgresql'
  else
    printf 'postgresql:///seti_%s?host=/var/run/postgresql' "$(printf '%s' "$home" | sha256 | cut -c1-12)"
  fi
}

sha256() {
  if have sha256sum; then
    sha256sum
  else
    shasum -a 256
  fi
}

# systemctl --user works here; sets the runtime directory that su and sudo -i sessions lack.
systemd_user() {
  [[ $(uname -s) == Linux ]] && have systemctl || return 1
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=${XDG_RUNTIME_DIR}/bus}"
  systemctl --user show-environment >/dev/null 2>&1
}

unit_enabled() { systemd_user && systemctl --user is-enabled "$1" >/dev/null 2>&1; }

# Waits for the health check: ping, then the local token is required and accepted.
health_check() {
  local port
  port="$(setting SETI_PORT)"
  SETI_URL="http://127.0.0.1:${port:-3006}" \
    SETI_TOKEN_FILE="$(credentials_dir)/local-token-user" \
    "${SETI_ROOT}/deploy/health-check.sh" "${1:-120}"
}

credentials_dir() {
  local dir
  dir="$(setting SETI_CREDENTIALS_DIR)"
  printf '%s' "${dir:-${SETI_HOME_DIR}/credentials}"
}

UNIT_DIR="${XDG_CONFIG_HOME:-${HOME}/.config}/systemd/user"
UNIT_MARK='# Written by scripts/install.sh from deploy/; run it again to update.'

unit_ours() { [[ -f "${UNIT_DIR}/$1" ]] && grep -qxF "$UNIT_MARK" "${UNIT_DIR}/$1"; }

# Writes a unit made from deploy/<name>, unless the file there is one the user wrote themselves.
render_unit() {
  local name=$1 dest="${UNIT_DIR}/$1" tmp path_line uv file
  if [[ -f $dest ]] && ! unit_ours "$name"; then
    warn "kept ${dest}: the installer did not write it, so it stays as it is"
    return 1
  fi
  path_line="$(dirname "$(command -v node)"):${HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin"
  uv="$(command -v uv || printf '%s' "${HOME}/.local/bin/uv")"
  mkdir -p "$UNIT_DIR"
  tmp="$(mktemp)"
  {
    printf '%s\n' "$UNIT_MARK"
    sed -e "s#%h/seti-live#${SETI_ROOT}#g" \
      -e "s#%h/\\.seti#${SETI_HOME_DIR}#g" \
      -e "s#%h/\\.local/bin/uv#${uv}#g" \
      -e "s#^ExecStart=.*zsh.*#ExecStart=${SETI_ROOT}/scripts/start.sh#" \
      -e "/^EnvironmentFile=/a Environment=PATH=${path_line}" \
      -e "/^EnvironmentFile=/a Environment=SETI_HOME=${SETI_HOME_DIR}" \
      "${SETI_ROOT}/deploy/${name}"
  } >"$tmp"
  install -m 0644 "$tmp" "$dest"
  rm -f "$tmp"
  # systemd refuses to start a unit whose LoadCredential= file is missing; empty means unset.
  sed -n 's/^LoadCredential=[^:]*://p' "$dest" | while IFS= read -r file; do
    [[ -e $file ]] || (umask 077 && : >"$file")
  done
  ok "wrote ${dest}"
}
