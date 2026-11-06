#!/usr/bin/env bash
# Installs Seti for the current user, or repairs an install; safe to run again at any time.
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/install.sh [options]
       curl -fsSL https://raw.githubusercontent.com/rickaym/seti/main/scripts/install.sh | bash

Checks this machine, installs what Seti needs, builds it, writes its settings and secrets, and
runs it as a systemd user service. Run it again to repair an install; scripts/upgrade.sh updates
one. It asks before every change outside your home directory and never prints a secret.

Options:
  --dir <path>          where to clone Seti when run through curl (default ~/seti)
  --ref <ref>           branch or tag to clone (default main)
  --database-url <url>  use this PostgreSQL database instead of a local one
  --port <port>         port Seti listens on at 127.0.0.1 (default 3006)
  --service             install and start the systemd user units without asking
  --no-service          do not install units; start Seti with scripts/start.sh instead
  --with-ea             also set up the Executive Assistant (voice and chat)
  --with-redis          also set up Seti's own Redis cache (Linux, needs sudo)
  --no-system           never use sudo; report what is missing instead
  -y, --yes             accept every default without asking
  -h, --help            show this help

Environment: SETI_HOME (default ~/.seti), SETI_REPO (default the GitHub repository).
USAGE
}

INSTALL_DIR="${SETI_DIR:-${HOME}/seti}"
SETI_REPO="${SETI_REPO:-https://github.com/rickaym/seti.git}"
SETI_REF="${SETI_REF:-main}"
DATABASE_URL_ARG=''
PORT_ARG=''
SERVICE=ask
WITH_EA=ask
WITH_REDIS=ask
NO_SYSTEM=0
ASSUME_YES=0
ORIGINAL_ARGS=("$@")

while [[ $# -gt 0 ]]; do
  case $1 in
    --dir) INSTALL_DIR=$2; shift ;;
    --ref) SETI_REF=$2; shift ;;
    --database-url) DATABASE_URL_ARG=$2; shift ;;
    --port) PORT_ARG=$2; shift ;;
    --service) SERVICE=yes ;;
    --no-service) SERVICE=no ;;
    --with-ea) WITH_EA=yes ;;
    --with-redis) WITH_REDIS=yes ;;
    --no-system) NO_SYSTEM=1 ;;
    -y | --yes) ASSUME_YES=1 ;;
    -h | --help) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

# Through curl there is no clone yet: make one, then run the installer it contains.
bootstrap() {
  if ! command -v git >/dev/null 2>&1; then
    if [[ $NO_SYSTEM -eq 0 ]] && command -v apt-get >/dev/null 2>&1 && command -v sudo >/dev/null 2>&1; then
      sudo apt-get update -qq </dev/null >/dev/null && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git ca-certificates </dev/null >/dev/null
    else
      printf 'Seti needs git: install it (sudo apt-get install git, or xcode-select --install) and retry.\n' >&2
      exit 1
    fi
  fi
  if [[ -d "${INSTALL_DIR}/.git" || -f "${INSTALL_DIR}/.git" ]]; then
    printf 'Using the Seti clone in %s\n' "$INSTALL_DIR"
  else
    printf 'Cloning Seti (%s) into %s\n' "$SETI_REF" "$INSTALL_DIR"
    git clone --quiet --branch "$SETI_REF" "$SETI_REPO" "$INSTALL_DIR" </dev/null
  fi
  exec bash "${INSTALL_DIR}/scripts/install.sh" ${ORIGINAL_ARGS[@]+"${ORIGINAL_ARGS[@]}"}
}

# Answers a question from the terminal; without one, or with --yes, takes the default.
confirm() {
  local question=$1 default=${2:-y} reply hint='[Y/n]'
  [[ $default == y ]] || hint='[y/N]'
  if [[ $ASSUME_YES -eq 1 ]] || ! { : </dev/tty; } 2>/dev/null; then
    [[ $default == y ]]
    return
  fi
  printf '%s %s ' "$question" "$hint" >/dev/tty
  read -r reply </dev/tty || reply=''
  case ${reply:-$default} in
    [Yy]*) return 0 ;;
    *) return 1 ;;
  esac
}

# Reads a secret from the terminal without echoing it; empty without a terminal.
read_secret() {
  local prompt=$1 value=''
  if [[ $ASSUME_YES -eq 0 ]] && { : </dev/tty; } 2>/dev/null; then
    printf '%s ' "$prompt" >/dev/tty
    IFS= read -rs value </dev/tty || value=''
    printf '\n' >/dev/tty
  fi
  printf '%s' "$value"
}

detect_platform() {
  OS="$(uname -s)"
  PKG=none
  SUDO=''
  case $OS in
    Linux)
      have apt-get && PKG=apt
      ;;
    Darwin)
      have brew && PKG=brew
      warn 'macOS is experimental: the agent sandbox and memory caps need Linux (bubblewrap, systemd).'
      note 'Agents can only run unsandboxed, as you, with your full access to files and credentials.'
      confirm 'Install anyway?' y || die 'Stopped. Seti is fully supported on Linux.'
      ;;
    *) die "Seti does not run on ${OS}; use Linux (Ubuntu 24.04 is the reference)." ;;
  esac
  [[ $(id -u) -ne 0 ]] || die 'Run the installer as the user Seti should run as, not root.' \
    'It asks for sudo itself when it installs system packages.'
  if [[ $NO_SYSTEM -eq 0 ]] && have sudo; then
    SUDO=sudo
  fi
  local where='' path
  for path in "$SETI_ROOT" "$SETI_HOME_DIR"; do
    case $path in *[[:space:]%]*) where=$path ;; esac
  done
  [[ -z $where ]] || die "The path ${where} has a space or %; move it to a plain path."
  ok "$(uname -sm), installing from ${SETI_ROOT}"
}

APT_REQUIRED=(git curl ca-certificates build-essential python3 bubblewrap socat openssl util-linux openssh-client)
APT_OPTIONAL=(gh jq ripgrep fd-find)
APT_PREVIEW=(poppler-utils ffmpeg resvg librsvg2-bin libreoffice-writer-nogui libreoffice-calc-nogui
  libreoffice-impress-nogui)

apt_installed() { [[ $(dpkg-query -W -f='${Status}' "$1" 2>/dev/null) == 'install ok installed' ]]; }

apt_candidate() {
  local policy
  policy="$(apt-cache policy "$1" 2>/dev/null)"
  [[ $policy == *'Candidate: '* && $policy != *'Candidate: (none)'* ]]
}

system_packages() {
  step 'System packages'
  if [[ $PKG != apt ]]; then
    [[ $OS == Darwin ]] || warn 'No apt-get: install git, curl, a C compiler, python3, PostgreSQL, bubblewrap,
        socat, openssl, util-linux and openssh with your package manager.'
    return 0
  fi
  local required=("${APT_REQUIRED[@]}") missing=() optional=() pkg
  if [[ -z $DATABASE_URL_ARG ]]; then
    required+=(postgresql)
  fi
  for pkg in "${required[@]}"; do
    apt_installed "$pkg" || missing+=("$pkg")
  done
  for pkg in "${APT_OPTIONAL[@]}"; do
    apt_installed "$pkg" || optional+=("$pkg")
  done
  if [[ ${#missing[@]} -eq 0 && ${#optional[@]} -eq 0 ]]; then
    ok 'everything installed'
    return 0
  fi
  if [[ -z $SUDO ]]; then
    [[ ${#missing[@]} -eq 0 ]] || die "missing packages: ${missing[*]}" "sudo apt-get install ${missing[*]}"
    warn "optional packages agents use when present: ${optional[*]}"
    return 0
  fi
  local all=(${missing[@]+"${missing[@]}"} ${optional[@]+"${optional[@]}"})
  if ! confirm "Install ${all[*]} with apt-get (sudo)?" y; then
    [[ ${#missing[@]} -eq 0 ]] || die 'Seti needs them.' "sudo apt-get install ${missing[*]}"
    return 0
  fi
  $SUDO apt-get update -qq </dev/null
  for pkg in ${optional[@]+"${optional[@]}"}; do
    apt_candidate "$pkg" && missing+=("$pkg")
  done
  DEBIAN_FRONTEND=noninteractive $SUDO apt-get install -y -qq "${missing[@]}" </dev/null >/dev/null
  ok "installed ${missing[*]}"
}

# Share previews of PDFs, Office files, media and SVG; without them a share shows the source.
preview_packages() {
  [[ $PKG == apt ]] || return 0
  step 'Share previews'
  local wanted=() pkg
  for pkg in "${APT_PREVIEW[@]}"; do
    apt_installed "$pkg" || ! apt_candidate "$pkg" || wanted+=("$pkg")
  done
  if [[ ${#wanted[@]} -eq 0 ]]; then
    ok 'poppler, ffmpeg, an SVG renderer and LibreOffice installed'
    return 0
  fi
  local question="Install share preview tools (${wanted[*]}; LibreOffice takes a few hundred MB)?"
  if [[ -z $SUDO ]] || ! confirm "$question" y; then
    warn "optional share preview packages: ${wanted[*]}"
    return 0
  fi
  $SUDO apt-get update -qq </dev/null
  DEBIAN_FRONTEND=noninteractive $SUDO apt-get install -y -qq --no-install-recommends "${wanted[@]}" </dev/null >/dev/null
  ok "installed ${wanted[*]}"
}

BWRAP_PROBE=(--unshare-user --unshare-pid --unshare-net --ro-bind / / --dev /dev --proc /proc true)

sandbox() {
  [[ $OS == Linux ]] || return 0
  step 'Agent sandbox'
  if ! have bwrap; then
    warn 'bubblewrap is missing, so no agent can start sandboxed.'
    return 0
  fi
  if bwrap "${BWRAP_PROBE[@]}" 2>/dev/null; then
    ok 'bubblewrap can create user namespaces'
    return 0
  fi
  local restrict=/proc/sys/kernel/apparmor_restrict_unprivileged_userns
  if [[ $(cat "$restrict" 2>/dev/null) != 1 ]]; then
    warn 'bubblewrap cannot create user namespaces; enable them (sysctl user.max_user_namespaces).'
    return 0
  fi
  if [[ -z $SUDO ]] || ! confirm 'AppArmor blocks bubblewrap. Add an AppArmor profile for bwrap (sudo)?' y; then
    warn 'Agents cannot start sandboxed until bwrap has an AppArmor profile; see docs/setup.md, Sandbox.'
    return 0
  fi
  local bwrap
  bwrap="$(command -v bwrap)"
  $SUDO tee /etc/apparmor.d/bwrap >/dev/null <<PROFILE
abi <abi/4.0>,
include <tunables/global>

profile bwrap ${bwrap} flags=(unconfined) {
  userns,
  include if exists <local/bwrap>
}
PROFILE
  $SUDO apparmor_parser -r /etc/apparmor.d/bwrap
  if bwrap "${BWRAP_PROBE[@]}" 2>/dev/null; then
    ok 'bubblewrap works with its AppArmor profile'
  else
    warn 'bubblewrap still cannot create user namespaces; pnpm run doctor shows the next step.'
  fi
}

node_toolchain() {
  step 'Node.js and pnpm'
  if ! use_node; then
    confirm "Install Node.js ${NODE_MAJOR} with nvm (into ~/.nvm)?" y || die "Seti needs Node.js ${NODE_MAJOR}." \
      "Install it, for example with nvm: https://github.com/nvm-sh/nvm"
    if [[ ! -s "${NVM_DIR:-${HOME}/.nvm}/nvm.sh" ]]; then
      curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VERSION}/install.sh" | bash >/dev/null
    fi
    set +eu
    # shellcheck disable=SC1091
    . "${NVM_DIR:-${HOME}/.nvm}/nvm.sh" >/dev/null
    nvm install "$NODE_MAJOR" >/dev/null
    set -eu
    use_node || die "nvm did not install Node.js ${NODE_MAJOR}."
  fi
  ok "node $(node --version) at $(command -v node)"
  export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
  if ! have pnpm; then
    local bin
    bin="$(dirname "$(command -v node)")"
    if [[ -w $bin ]]; then
      corepack enable pnpm
    else
      mkdir -p "${HOME}/.local/bin"
      corepack enable --install-directory "${HOME}/.local/bin" pnpm
      export PATH="${HOME}/.local/bin:${PATH}"
    fi
  fi
  ok "pnpm $(cd "$SETI_ROOT" && pnpm --version)"
}

install_uv() {
  if have uv || [[ -x "${HOME}/.local/bin/uv" ]]; then
    export PATH="${HOME}/.local/bin:${PATH}"
    return 0
  fi
  confirm 'Install uv (Python tooling for the EA) into ~/.local/bin?' y || return 1
  curl -LsSf https://astral.sh/uv/install.sh | sh >/dev/null
  export PATH="${HOME}/.local/bin:${PATH}"
}

claude_code() {
  step 'Claude Code'
  if have claude || [[ -x "${HOME}/.local/bin/claude" ]]; then
    ok "claude at $(command -v claude || printf '%s' "${HOME}/.local/bin/claude")"
  elif confirm 'Install the Claude Code CLI (for signing in) into ~/.local/bin?' y; then
    curl -fsSL https://claude.ai/install.sh | bash >/dev/null
    ok 'installed claude'
  else
    warn 'Without the CLI, sign in with "claude setup-token" elsewhere and paste it in Settings, Credentials.'
  fi
}

postgres_local() {
  local socket=/var/run/postgresql user
  user="$(id -un)"
  have psql || die 'PostgreSQL is not installed.' 'sudo apt-get install postgresql, or pass --database-url'
  if ! pg_isready -q -h "$socket" 2>/dev/null; then
    [[ -n $SUDO ]] || die 'PostgreSQL is not running.' 'sudo systemctl start postgresql'
    $SUDO systemctl enable --now postgresql 2>/dev/null || $SUDO service postgresql start
  fi
  local role
  role="$(cd / && psql -h "$socket" -d postgres -XAtc \
    'SELECT rolcreatedb OR rolsuper FROM pg_roles WHERE rolname = current_user' 2>/dev/null || true)"
  case $role in
    t) ok "PostgreSQL role ${user} may create Seti's database" ;;
    f)
      [[ -n $SUDO ]] || die "Role ${user} may not create databases." "sudo -u postgres psql -c 'ALTER ROLE \"${user}\" CREATEDB'"
      (cd / && $SUDO -u postgres psql -Xq -c "ALTER ROLE \"${user}\" CREATEDB" </dev/null)
      ok "allowed role ${user} to create databases"
      ;;
    *)
      [[ -n $SUDO ]] || die "PostgreSQL has no role ${user}." "sudo -u postgres createuser --createdb ${user}"
      confirm "Create the PostgreSQL role ${user} (peer authentication, no password)?" y ||
        die 'Seti needs a role.' "sudo -u postgres createuser --createdb ${user}"
      (cd / && $SUDO -u postgres createuser --createdb "$user" </dev/null)
      ok "created PostgreSQL role ${user}"
      ;;
  esac
}

postgres_macos() {
  if ! have psql; then
    [[ $PKG == brew ]] || die 'PostgreSQL is not installed.' 'brew install postgresql@16, or pass --database-url'
    confirm 'Install PostgreSQL 16 with Homebrew?' y || die 'Seti needs PostgreSQL.'
    brew install postgresql@16
    brew services start postgresql@16
    PATH="$(brew --prefix postgresql@16)/bin:${PATH}"
    export PATH
  fi
  DATABASE_SETTING='postgresql:///seti?host=/tmp'
  ok 'PostgreSQL on /tmp'
}

DATABASE_SETTING=''

database() {
  step 'PostgreSQL'
  if [[ -n $DATABASE_URL_ARG ]]; then
    DATABASE_SETTING=$DATABASE_URL_ARG
    ok 'using the database from --database-url; Seti migrates it on start'
  elif [[ -n $(setting SETI_DATABASE_URL) ]]; then
    ok 'using SETI_DATABASE_URL from seti.env'
  elif [[ $OS == Darwin ]]; then
    postgres_macos
  else
    postgres_local
  fi
}

REDIS_ON=0

redis_cache() {
  local socket=/run/seti-redis/redis.sock user
  user="$(id -un)"
  if [[ -S $socket ]]; then
    REDIS_ON=1
    ok "Seti's Redis is running"
    return 0
  fi
  if [[ $WITH_REDIS == ask ]]; then
    [[ $OS == Linux && $PKG == apt && -n $SUDO ]] || return 0
    confirm "Set up Seti's own Redis cache (optional, sudo)?" n || return 0
  fi
  [[ $OS == Linux && $PKG == apt && -n $SUDO ]] || die '--with-redis needs Linux with apt-get and sudo.'
  step 'Redis'
  $SUDO systemctl mask redis-server.service >/dev/null 2>&1 || true
  DEBIAN_FRONTEND=noninteractive $SUDO apt-get install -y -qq redis-server </dev/null >/dev/null 2>&1 ||
    die 'apt-get install redis-server failed.' 'sudo apt-get install redis-server'
  $SUDO install -D -m 644 "${SETI_ROOT}/deploy/seti-redis.conf" /etc/seti/redis.conf
  $SUDO install -m 644 "${SETI_ROOT}/deploy/seti-redis@.service" /etc/systemd/system/seti-redis@.service
  $SUDO systemctl daemon-reload
  $SUDO systemctl enable --now "seti-redis@${user}"
  REDIS_ON=1
  ok "seti-redis@${user} on ${socket}"
}

build() {
  step 'Dependencies and build'
  local log="${SETI_HOME_DIR}/install.log"
  (umask 077 && mkdir -p "$SETI_HOME_DIR")
  note "pnpm install and pnpm build, a few minutes; output in ${log}"
  if ! (cd "$SETI_ROOT" && pnpm install --frozen-lockfile && pnpm build) >"$log" 2>&1; then
    tail -n 30 "$log" >&2
    die 'pnpm install or pnpm build failed.' "the full output is in ${log}"
  fi
  ok 'installed and built'
}

CREDENTIALS_GENERATED=(secret-key local-token-user local-token-ea)
CREDENTIALS_OPTIONAL=(openai-api-key deepgram-api-key elevenlabs-api-key cloudflare-turn-key-id
  cloudflare-turn-api-token tunnel-token)

random_value() {
  node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString(process.argv[1]))" "$1"
}

write_secret() {
  (umask 077 && printf '%s\n' "$2" >"$1")
  chmod 600 "$1"
}

credentials() {
  step 'Settings and secrets'
  local dir name file
  dir="$(credentials_dir)"
  (umask 077 && mkdir -p "$SETI_HOME_DIR" "$dir")
  chmod 700 "$SETI_HOME_DIR" "$dir"
  for name in "${CREDENTIALS_GENERATED[@]}"; do
    file="${dir}/${name}"
    if [[ -s $file ]]; then
      continue
    fi
    if [[ $name == secret-key ]]; then
      write_secret "$file" "$(random_value base64)"
    else
      write_secret "$file" "$(random_value base64url)"
    fi
    ok "generated ${file}"
  done
  for name in "${CREDENTIALS_OPTIONAL[@]}"; do
    [[ -e "${dir}/${name}" ]] || write_secret "${dir}/${name}" ''
  done
  ok "secrets in ${dir} (owner-only files)"
}

# Adds a setting to seti.env unless the file already sets it; never changes an existing value.
add_setting() {
  local file="${SETI_HOME_DIR}/seti.env" key=$1 value=$2 current
  current="$(env_value "$file" "$key")"
  if grep -Eq "^[[:space:]]*(export[[:space:]]+)?${key}=" "$file"; then
    [[ $current == "$value" ]] || warn "kept the ${key} that ${file} sets; the installer chose another value"
    return 0
  fi
  printf '%s=%s\n' "$key" "$value" >>"$file"
  ok "set ${key} in ${file}"
}

settings_file() {
  local file="${SETI_HOME_DIR}/seti.env"
  if [[ ! -f $file ]]; then
    (umask 077 && printf '# Seti settings; docs/setup.md lists them all. Restart Seti after a change.\n' >"$file")
  fi
  chmod 600 "$file"
  [[ -z $DATABASE_SETTING ]] || add_setting SETI_DATABASE_URL "$DATABASE_SETTING"
  [[ -z $PORT_ARG ]] || add_setting SETI_PORT "$PORT_ARG"
  if [[ $REDIS_ON -eq 1 ]]; then
    if [[ $(env_value "$file" SETI_REDIS_URL) == off ]]; then
      warn "${file} turns Redis off; delete its SETI_REDIS_URL line to use Seti's Redis"
    fi
  else
    add_setting SETI_REDIS_URL off
  fi
}

SERVICE_STARTED=0

# Lingering keeps user services up without a login; turning it on also starts the user manager.
linger() {
  local user state tries=0
  user="$(id -un)"
  state="$(loginctl show-user "$user" --property=Linger --value 2>/dev/null || true)"
  [[ $state != yes ]] || return 0
  if [[ -z $SUDO ]] || ! confirm 'Keep Seti running when you are logged out (sudo loginctl enable-linger)?' y; then
    warn "Seti stops when you log out; sudo loginctl enable-linger ${user} keeps it running"
    return 0
  fi
  $SUDO loginctl enable-linger "$user"
  until systemd_user || [[ $tries -ge 20 ]]; do
    sleep 0.5
    tries=$((tries + 1))
  done
  ok 'lingering on'
}

service() {
  [[ $SERVICE != ask || ! -f "${UNIT_DIR}/seti.service" ]] || SERVICE=yes
  if [[ $SERVICE == no ]]; then
    return 0
  fi
  if [[ $OS != Linux || ! -d /run/systemd/system ]]; then
    [[ $SERVICE != yes ]] || warn 'This machine does not run systemd; start Seti with scripts/start.sh.'
    return 0
  fi
  if [[ $SERVICE == ask ]] && ! confirm 'Run Seti as a systemd user service that starts with the machine?' y; then
    return 0
  fi
  step 'Service'
  linger
  if ! systemd_user; then
    warn 'No systemd user manager for this session: log in as this user directly, then run the installer again.'
    return 0
  fi
  render_unit seti.service || return 0
  systemctl --user daemon-reload
  systemctl --user enable seti.service >/dev/null 2>&1
  systemctl --user restart seti.service
  if health_check 180; then
    SERVICE_STARTED=1
    ok 'seti.service is running and refuses calls without the local token'
  else
    journalctl --user -u seti.service -n 30 --no-pager >&2 || true
    die 'seti.service did not become healthy.' 'journalctl --user -u seti.service -n 100'
  fi
}

ea_key_prompt() {
  local dir name value
  dir="$(credentials_dir)"
  for name in openai-api-key deepgram-api-key elevenlabs-api-key; do
    [[ -n $(tr -d '[:space:]' <"${dir}/${name}" 2>/dev/null) ]] && continue
    value="$(read_secret "Paste the ${name%-api-key} API key (Enter skips):")"
    if [[ -n $value ]]; then
      write_secret "${dir}/${name}" "$value"
      ok "saved ${dir}/${name}"
    fi
  done
}

assistant() {
  if [[ $WITH_EA == ask ]]; then
    if [[ -f "${UNIT_DIR}/seti-ea.service" || -d "${SETI_ROOT}/ea/.venv" ]]; then
      WITH_EA=yes
    else
      confirm 'Set up the Executive Assistant (chat needs an OpenAI key; voice also Deepgram, ElevenLabs)?' n ||
        return 0
    fi
  fi
  step 'Executive Assistant'
  install_uv || die 'The EA needs uv.' 'curl -LsSf https://astral.sh/uv/install.sh | sh'
  (cd "$SETI_ROOT" && uv sync --project ea --locked --quiet && uv run --project ea --frozen python -m seti_ea.models)
  ok 'EA dependencies and wake word model installed'
  ea_key_prompt
  if [[ $SERVICE_STARTED -eq 1 ]] && render_unit seti-ea.service; then
    systemctl --user daemon-reload
    systemctl --user enable seti-ea.service >/dev/null 2>&1
    systemctl --user restart seti.service seti-ea.service
    health_check 180 >/dev/null || warn 'Seti did not answer after the restart; see pnpm run doctor.'
    ok 'seti-ea.service is running'
  else
    note 'Start it with: uv run --project ea --frozen python -m seti_ea'
  fi
}

finish() {
  step 'Checking the install'
  (cd "$SETI_ROOT" && pnpm --silent run doctor) || true
  local port token
  port="$(setting SETI_PORT)"
  token="$(credentials_dir)/local-token-user"
  step 'Done'
  printf '  Open      http://seti.localhost:%s (another machine: ssh -L %s:127.0.0.1:%s <this host>)\n' \
    "${port:-3006}" "${port:-3006}" "${port:-3006}"
  printf '  Sign in   with the token in %s (cat it; the installer never shows it)\n' "$token"
  if [[ $SERVICE_STARTED -eq 1 ]]; then
    printf '  Logs      journalctl --user -u seti.service -f\n'
  else
    printf '  Start     %s/scripts/start.sh\n' "$SETI_ROOT"
  fi
  printf '  Check     cd %s && pnpm run doctor\n' "$SETI_ROOT"
  printf '  Upgrade   %s/scripts/upgrade.sh\n' "$SETI_ROOT"
  printf '  Guide     %s/docs/setup.md\n' "$SETI_ROOT"
  if [[ $OS == Darwin ]]; then
    printf '\n  macOS: turn the sandbox off in Settings, Sandbox before starting an agent.\n'
  fi
  printf '\n  Next: sign in to Claude Code (claude, then /login) and GitHub (gh auth login).\n'
}

main() {
  local self="${BASH_SOURCE[0]:-}"
  if [[ -z $self || ! -f "$(dirname "$self")/lib.sh" ]]; then
    bootstrap
  fi
  # shellcheck source=scripts/lib.sh
  . "$(dirname "$self")/lib.sh"
  detect_platform
  system_packages
  preview_packages
  sandbox
  node_toolchain
  claude_code
  database
  redis_cache
  build
  credentials
  settings_file
  service
  assistant
  finish
}

main
