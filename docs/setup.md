# Installing Seti

TLDR: on Linux, run the one-line installer. It checks the machine, installs what is missing
(asking before anything that needs sudo), builds Seti, writes its settings and secrets, and runs it
as a systemd user service on `127.0.0.1:3006`. Open `http://seti.localhost:3006` and sign in with
the token in `~/.seti/credentials/local-token-user`. `scripts/upgrade.sh` updates it later, and
`pnpm run doctor` says what is wrong and how to fix it.

```sh
curl -fsSL https://raw.githubusercontent.com/rickaym/seti/main/scripts/install.sh | bash
```

## Quickstart

1. Run the installer as the user Seti should run as (not root). From a clone, run
   `scripts/install.sh` instead; through curl, it clones Seti to `~/seti` first.
2. When it finishes, open a new shell so it finds the tools the installer added to `~/.local/bin`
   and nvm, then log in to Claude Code (`claude`, then `/login`) and to GitHub (`gh auth login`).
   Agents use your Claude login; Seti watches your PRs with your `gh` login.
3. Open `http://seti.localhost:3006`. From another machine, forward the port first:
   `ssh -L 3006:127.0.0.1:3006 <host>`.
4. Sign in with the local token: `cat ~/.seti/credentials/local-token-user` and paste it. The
   browser keeps an HttpOnly session cookie for 30 days.
5. In Settings, add repos under Repos, and check the Claude account under Account and the sandbox
   under Sandbox.

Pass options after `bash -s --` when you use curl:

```sh
curl -fsSL https://raw.githubusercontent.com/rickaym/seti/main/scripts/install.sh | bash -s -- --yes --with-ea
```

| Option                 | What it does                                                           |
| ---------------------- | ---------------------------------------------------------------------- |
| `--yes`                | Accepts every default without asking, for scripts and CI               |
| `--dir <path>`         | Where curl clones Seti; `~/seti` by default                            |
| `--ref <ref>`          | Branch or tag to clone; `main` by default                              |
| `--database-url <url>` | Uses an existing PostgreSQL database instead of installing one         |
| `--port <port>`        | Listens on another port at `127.0.0.1`                                 |
| `--service`            | Installs and starts the systemd units without asking                   |
| `--no-service`         | Installs no units; run Seti with `scripts/start.sh`                    |
| `--with-ea`            | Also sets up the Executive Assistant; asks for its keys unless `--yes` |
| `--with-redis`         | Also sets up Seti's own Redis (Linux, sudo)                            |
| `--no-system`          | Never runs sudo; stops with the command to run when a package is due   |

The installer is idempotent. Run it again to repair an install: it keeps every secret and setting
that exists, adds what is missing, rebuilds, and restarts the service. It never prints a secret.

## Requirements

| Platform                     | Support                                                                                         |
| ---------------------------- | ----------------------------------------------------------------------------------------------- |
| Ubuntu 24.04 (x86_64)        | Reference platform. The installer sets up everything with apt and is tested on a clean system   |
| Other apt-based Linux, arm64 | Expected to work, not tested: the installer uses the distribution's packages and PostgreSQL     |
| Other Linux with systemd     | Install the packages below with your package manager, then run the installer                    |
| macOS                        | Experimental and untested. No sandbox and no memory caps, so agents run as you; no service unit |
| Windows                      | Not supported. WSL 2 with systemd enabled may behave like Linux                                 |

On macOS the installer uses Homebrew for PostgreSQL, sets `SETI_DATABASE_URL` to its `/tmp`
socket, and leaves you to run `scripts/start.sh`. The sandbox needs bubblewrap and the memory caps
need systemd, both Linux-only, so agents can only run with the sandbox turned off in Settings,
Sandbox: as your user, with your files and credentials.

What Seti needs, and what the installer does about each:

| Component                                              | Why                                                      | Installer                                       |
| ------------------------------------------------------ | -------------------------------------------------------- | ----------------------------------------------- |
| Node.js 24 and pnpm                                    | Runs the server and builds the UI                        | Uses Node 24 on PATH, else installs it with nvm |
| PostgreSQL 16                                          | All state; Seti creates and migrates its database        | apt package, role for your user, peer auth      |
| bubblewrap, socat, util-linux, openssl, openssh-client | The agent sandbox, its egress proxy and SSH for agents   | apt packages, AppArmor profile for bwrap        |
| build-essential, python3                               | Compiles node-pty when no prebuilt binary fits           | apt packages                                    |
| systemd user manager                                   | Runs Seti as a service and caps agents' memory           | Units in `~/.config/systemd/user`, lingering    |
| Claude Code                                            | Signing in; Seti runs the Agent SDK's own binary         | Installs the CLI into `~/.local/bin`            |
| gh, jq, ripgrep, fd-find (optional)                    | PR watching; faster agents                               | apt packages when available                     |
| poppler-utils, ffmpeg, resvg, LibreOffice (optional)   | Share link previews of PDFs, media, SVG and Office files | apt packages, after asking                      |
| uv (optional)                                          | The Executive Assistant and `pnpm check`                 | With `--with-ea`                                |
| Redis (optional)                                       | Shared cache; Seti works without it                      | With `--with-redis`                             |

LibreOffice means its headless packages, `libreoffice-writer-nogui`, `libreoffice-calc-nogui` and
`libreoffice-impress-nogui`. Where apt has no `resvg`, as on Ubuntu 24.04, `librsvg2-bin` renders SVG
instead. Without these tools a share link still works and shows the file's source or a download.

## What runs where

Seti runs as your user. `seti.service` starts `scripts/start.sh`, which runs the server from the
clone with the settings in `~/.seti/seti.env`; systemd passes the secrets from
`~/.seti/credentials` with `LoadCredential=`, so none reaches an environment variable. Seti listens
on `127.0.0.1` only. Logs are in `journalctl --user -u seti.service`.

The installer writes its units from `deploy/seti.service` and `deploy/seti-ea.service`, with the
clone's path, your Node and a marker line. It never replaces a unit file that lacks the marker, so
a hand-made unit stays as it is. Without systemd (macOS, containers), run Seti in the foreground:

```sh
~/seti/scripts/start.sh
```

Outside systemd, Seti reads its secrets from `~/.seti/credentials` (or `SETI_CREDENTIALS_DIR`)
itself. A production run never creates a secret; the installer does.

## Signing in

Every API call needs a credential:

- On loopback (`seti.localhost`, `localhost`, `127.0.0.1`), the local token, as
  `Authorization: Bearer <token>` or the session cookie the sign-in page sets, or a passkey
  session. The local token always works on loopback, so it is the way back in.
- On the public hostname (`SETI_PUBLIC_URL`), a passkey session, or a Cloudflare Access login that
  Seti verifies itself when Access guards the hostname.

Add passkeys in Settings, Sign-in from a browser that is already signed in. `pnpm setup-code` on
the host prints a one-time code that enrolls the first passkey from anywhere.

Only `/api/ping` and the sign-in calls answer without one. Scripts send the token with curl's `-K`,
so it stays out of the process list:

```sh
curl -s -K <(printf 'header = "Authorization: Bearer %s"\n' "$(cat ~/.seti/credentials/local-token-user)") \
  http://127.0.0.1:3006/api/system
```

To sign every browser out, rotate the token: see [Security](security.md#rotating).

## Exposing Seti remotely

Seti listens on loopback by default, and that is the safest setup. Anyone who can drive its API
can run commands as your user, so expose it only through one of these, never by setting
`SETI_HOST=0.0.0.0` on an open network.

| Option                     | Who gets in                                 | Setup                                                  |
| -------------------------- | ------------------------------------------- | ------------------------------------------------------ |
| SSH port forward           | Anyone with SSH access to the host          | `ssh -L 3006:127.0.0.1:3006 <host>`; nothing to set    |
| Reverse proxy with TLS     | Only your passkeys                          | `SETI_PUBLIC_URL` and a proxy such as Caddy or nginx   |
| Cloudflare Tunnel + Access | Identities Access admits, and your passkeys | `SETI_PUBLIC_URL` and the Access settings, cloudflared |

### Reverse proxy

Run the proxy on the same host, terminate TLS there, forward to `127.0.0.1:3006` with the original
`Host` header, and pass WebSocket upgrades (agent terminals use them). Then tell Seti its public
origin in `~/.seti/seti.env` and restart it:

```sh
SETI_PUBLIC_URL=https://seti.example.com
```

Without the Access settings, Seti admits only passkey sessions on that hostname: enroll the first
passkey with the code `pnpm setup-code` prints, or from a loopback browser in Settings, Sign-in.
The session cookie is `Secure` and `__Host-` prefixed, writes must come from that origin, and
responses carry HSTS. The URL must be https on a public name without a port. Every other `Host` is
still refused. Caddy needs only this:

```text
seti.example.com {
  reverse_proxy 127.0.0.1:3006
}
```

With nginx, keep `Host` and the upgrade headers:

```text
location / {
  proxy_pass http://127.0.0.1:3006;
  proxy_set_header Host $host;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_read_timeout 1h;
  client_max_body_size 60m;
}
```

Your passkeys are then the only thing between the internet and your shell. Use a proxy you trust,
and add the proxy's own authentication (mTLS, or an identity-aware proxy) on top when you can.
Paired phones and webhooks need nothing extra behind a proxy.

### Cloudflare Tunnel and Access

1. Create a Cloudflare Tunnel with a public hostname pointing at `http://127.0.0.1:3006`. Leave the
   HTTP Host Header empty and add no wildcard hostname.
2. Add a self-hosted Access application for that hostname that allows only you.
3. Write the tunnel token to `~/.seti/credentials/tunnel-token`, and set `SETI_PUBLIC_URL`,
   `SETI_ACCESS_TEAM`, `SETI_ACCESS_AUD` and `SETI_ACCESS_EMAILS` in `~/.seti/seti.env`.
4. Install `cloudflared` to `~/.local/bin`, then the unit, and restart Seti:

```sh
install -m 644 ~/seti/deploy/cloudflared.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user restart seti.service
systemctl --user enable --now cloudflared.service
```

Seti refuses to start with half the Access settings, and it refuses requests that come through
Cloudflare on any other hostname. Then sign in through Access, open Settings, Sign-in, add a
passkey and turn on Require passkey: from then on the public hostname needs a passkey session as
well.

Notification channels (Settings, Channels) receive webhooks at `/hooks/<id>`, which Seti verifies
by signature instead of Access. Add a second self-hosted Access application for the same hostname
with path `hooks/` and a Bypass policy that includes Everyone; Access applies the most specific
path, so everything else still needs the login. If Bot Fight Mode or a WAF rule challenges the
zone, skip it for `/hooks/` too.

Share links (Settings, Sharing) open at `/share/<token>` for anyone who has one. To let them past
Access, add a Bypass application the same way with path `share/`; Seti itself lets through only a
GET or HEAD of a share's page or download, and every other path under `/share/` still needs the
login. Skip Bot Fight Mode or WAF challenges for `/share/` as for `/hooks/`.

The phone app cannot pass Access, so with the app in use add Bypass applications the same way for
`api/devices/pair`, `api/widget/` and `.well-known/assetlinks.json`; Seti still refuses them
without a pairing code or device proof. `assetlinks.json` names the official app with no setup.
Only an app you build and sign yourself needs its package and certificate, under Self-built app in
Settings, Sign-in (or `SETI_ANDROID_PACKAGE` and `SETI_ANDROID_CERT_SHA256`).

## Configuration

Settings live in `~/.seti/seti.env` (one `NAME=value` per line) and secrets in
`~/.seti/credentials`, one owner-only file each. Restart Seti after a change:
`systemctl --user restart seti.service`. `pnpm run doctor` reads the same file and reports a value
Seti would refuse.

### Server

| Variable                                           | Default                      | Purpose                                                           |
| -------------------------------------------------- | ---------------------------- | ----------------------------------------------------------------- |
| `SETI_HOME`                                        | `~/.seti`                    | Seti's data directory                                             |
| `SETI_CREDENTIALS_DIR`                             | `SETI_HOME/credentials`      | Secrets outside systemd; under systemd, `LoadCredential=` wins    |
| `SETI_DATABASE_URL`                                | `seti` on the local socket   | PostgreSQL database as a libpq URL                                |
| `SETI_REDIS_URL`                                   | `/run/seti-redis/redis.sock` | Redis socket or `redis://` URL; `off` runs without Redis          |
| `SETI_HOST`, `SETI_PORT`                           | `127.0.0.1`, `3006`          | Listen address                                                    |
| `SETI_PUBLIC_URL`                                  | unset                        | Public origin, such as `https://seti.example.com`                 |
| `SETI_ACCESS_TEAM`, `SETI_ACCESS_AUD`              | unset                        | Access team domain and application audience tag                   |
| `SETI_ACCESS_EMAILS`                               | unset                        | Access identities allowed in; unset allows all Access admits      |
| `SETI_AUTH_IDLE_DAYS`, `SETI_AUTH_MAX_DAYS`        | `7`, `30`                    | Passkey session idle and absolute limits                          |
| `SETI_ANDROID_PACKAGE`, `SETI_ANDROID_CERT_SHA256` | unset                        | A self-built Android app to trust until Settings sets one         |
| `SETI_CLAUDE_HOME`, `SETI_CLAUDE_BIN`              | `~/.claude`, see below       | Claude Code config, and the binary sessions run                   |
| `SETI_SCRATCH_ROOT`                                | `~/work`                     | Where agents without a repo get a directory                       |
| `SETI_SESSION_IDLE_MINUTES`                        | `15`                         | How long an idle agent's process stays open                       |
| `SETI_MEMORY_SCOPES`                               | on                           | `off` runs agents without systemd memory and CPU caps             |
| `SETI_AUDIT_RETENTION_DAYS`                        | `365`                        | Days the audit log keeps events                                   |
| `SETI_TASK_RETENTION_DAYS`                         | unset                        | Days idle before a task is deleted; unset keeps all               |
| `SETI_POLLER_WORKERS`                              | `2`                          | Worker threads for poller scripts, 1 to 3                         |
| `SETI_MOD_WORKERS`                                 | `1`                          | Locked-down processes for third-party mod logic, 1 to 3           |
| `SETI_BACKUP_PUBLIC_KEY`                           | unset                        | Key backups are encrypted to; unset turns backups off             |
| `SETI_BACKUP_KEEP`, `SETI_BACKUP_INTERVAL_HOURS`   | `14`, `24`                   | Backups kept and hours between them                               |
| `SETI_EA_URL`                                      | `http://127.0.0.1:3007`      | Where `/api/ea` forwards to                                       |
| `SETI_EA_ENV`                                      | `SETI_HOME/ea.env`           | Env file Seti reads `OPENAI_API_KEY` from, as a fallback          |
| `OPENAI_API_KEY`                                   | unset                        | Embeddings for EA search, when the `openai-api-key` file is empty |
| `SETI_WEATHER_URL`                                 | Open-Meteo                   | Weather mod's forecast, on api.open-meteo.com; `off` disables     |
| `SETI_SAFE_MODE`                                   | unset                        | `1` keeps every third-party mod off, whatever Settings, Mods says |
| `NODE_ENV`                                         | unset                        | `development` makes a run create its own secrets (see below)      |
| `SETI_DEV_CREDENTIALS_DIR`                         | `SETI_HOME/dev-credentials`  | Secrets of a development or test run                              |
| `SETI_TEST_MODS`                                   | unset                        | `1` loads the mods Seti's own tests use, in a development run     |

`SETI_CLAUDE_BIN` defaults to a working `claude` on PATH, else the binary the Agent SDK ships.
Without `SETI_DATABASE_URL`, a `SETI_HOME` other than `~/.seti` gets its own database, named after
the directory, so a scratch instance never shares the live one.

### Secrets

| File in `~/.seti/credentials`                         | Used by        | Made by                      |
| ----------------------------------------------------- | -------------- | ---------------------------- |
| `secret-key`                                          | Seti           | The installer                |
| `local-token-user`                                    | Seti, browsers | The installer                |
| `local-token-ea`                                      | Seti, the EA   | The installer                |
| `openai-api-key`                                      | Seti, the EA   | You (optional)               |
| `deepgram-api-key`, `elevenlabs-api-key`              | The EA         | You (optional, voice)        |
| `cloudflare-turn-key-id`, `cloudflare-turn-api-token` | The EA         | You (optional, remote calls) |
| `tunnel-token`                                        | `cloudflared`  | You (optional)               |

An empty file means unset; systemd needs every file a unit loads to exist, so the installer creates
the optional ones empty. Keep `secret-key` in a password manager: tokens set in the UI are sealed
with it, and backups do not contain it. [Security](security.md) covers rotation.

### Executive Assistant

The EA reads its key files first, then its environment, then `SETI_EA_ENV`
(`~/.seti/ea.env`).

| Variable                                              | Default                   | Purpose                                                    |
| ----------------------------------------------------- | ------------------------- | ---------------------------------------------------------- |
| `OPENAI_API_KEY`                                      | unset                     | Chat and the voice model; credential `openai-api-key`      |
| `DEEPGRAM_API_KEY`, `ELEVENLABS_API_KEY`              | unset                     | Speech to text and text to speech for calls                |
| `CLOUDFLARE_TURN_KEY_ID`, `CLOUDFLARE_TURN_API_TOKEN` | unset                     | TURN relay for calls from outside the host's network       |
| `SETI_API_TOKEN`                                      | unset                     | Seti's EA token; the unit loads `local-token-ea`           |
| `SETI_API`                                            | `http://127.0.0.1:3006`   | Where the EA reaches Seti                                  |
| `EA_PORT`                                             | `3007`                    | Listen port on `127.0.0.1`                                 |
| `EA_MODEL`, `EA_TEXT_MODEL`                           | `gpt-6-sol`, same         | Voice model, and the chat model when different             |
| `EA_REASONING_EFFORT`                                 | `none`                    | `default` for a model without reasoning, such as `gpt-4.1` |
| `ELEVENLABS_VOICE_ID`, `ELEVENLABS_MODEL`             | a set voice, flash v2.5   | The voice                                                  |
| `EA_HISTORY_MAX_TOKENS`                               | `8000`                    | Conversation kept per call, at least 200                   |
| `EA_INBOX_POLL_SECS`                                  | `5`                       | How often the EA checks its inbox                          |
| `SETI_EA_MODEL_DIR`                                   | `~/.cache/seti-ea/models` | Wake word model; `XDG_CACHE_HOME` moves the default        |

### Scripts

| Variable                            | Used by                  | Purpose                                          |
| ----------------------------------- | ------------------------ | ------------------------------------------------ |
| `SETI_DIR`, `SETI_REPO`, `SETI_REF` | `scripts/install.sh`     | Clone path, repository and ref for the curl run  |
| `SETI_URL`, `SETI_TOKEN_FILE`       | `deploy/health-check.sh` | Where Seti answers and the token to call it with |

Development and tests also read `SETI_TEST_DATABASE_URL`, `SETI_TEST_REDIS_URL`,
`SETI_POLLER_LOOPBACK`, `SETI_PUSH_LOOPBACK`, `SETI_MOD_TEST_UPSTREAM`, `SETI_PLANNER_MODULE`,
`SETI_SDK_MODULE`, `SETI_TERMINAL_SHELL`, `SETI_PROBE_DELAY_MS`, `SETI_PR_POLL_MS`, `SETI_AWAY_MS`
and the `SETI_E2E_*` variables; production ignores the loopback, upstream, module, terminal shell,
probe, poll and away ones.

## Optional pieces

### Executive Assistant

The EA is a Python process (pipecat) on `127.0.0.1:3007`. `scripts/install.sh --with-ea` installs
uv, the EA's dependencies and its wake word model (about 9 MB, in `~/.cache/seti-ea/models`), asks
for the keys without echoing them, and starts `seti-ea.service`. The chat needs only the OpenAI
key; calls also need Deepgram and ElevenLabs, and the TURN keys for calls from other networks.
`GET /api/ea/health` lists missing keys, and Settings, EA holds the wake word, audio devices,
models and Address as: the title or name the EA calls you now and then, empty for no title, which
is the default. To add a key later, write it to its file and restart both services:

```sh
(umask 077; printf '%s\n' 'sk-...' > ~/.seti/credentials/openai-api-key)
systemctl --user restart seti.service seti-ea.service
```

A call keeps going while Seti is in the background, as when you switch apps on a phone. The page
pings the EA from a worker every second, since the EA drops its voice three seconds after the last
ping and a background page slows its own timers. A network stall ends the call only once the
browser declares the path failed, after about 30 seconds. While a call is live, the phone shows it
as media with Mute and Hang up. Each call end goes to the audit log as `ea.call_ended`, with its
reason, its length and whether Seti was in the background, but no audio or words; Settings, EA
shows the last one. On Android, Chrome sends call audio to a Bluetooth headset only when Chrome may
use Nearby devices (Android settings, Apps, Chrome, Permissions).

### Redis

Without Redis every cache read misses and Seti still works; the installer writes
`SETI_REDIS_URL=off` unless you choose Redis. `--with-redis` installs Seti's own Redis instance on a
unix socket only your user can open, with no TCP port and no persistence (`deploy/seti-redis.conf`
and `deploy/seti-redis@.service`). It masks the stock `redis-server` unit so nothing listens on a
port.

### pgvector

pgvector lets the EA search by embeddings as well as full text. Only a superuser can create the
extension, so do it once Seti has created its database:

```sh
sudo apt-get install postgresql-16-pgvector
sudo -u postgres psql -d seti -c 'CREATE EXTENSION IF NOT EXISTS vector'
```

### Credentials and connections for agents

Sandboxed agents hold no keys or tokens; the agent's egress proxy adds them. For Anthropic it uses
the Claude token in Settings, Credentials (from `claude setup-token`), otherwise the host's Claude
Code login.

A connection is one service's access, made in Settings, Connections: its name, the hosts it may
reach (exact or `*.suffix`), how Seti signs in, and the values that takes. Agents see its variable,
such as `STRIPE`, holding a placeholder. The proxy swaps the placeholder for the value in headers
and URLs on the connection's hosts only and refuses a request that carries it anywhere else. With
"Seti adds it" on, the proxy also sets a header from a template (`Bearer {{value}}`) on every
request to those hosts, so the agent never sends it. A connection signs in one of four ways:

- A key the user pastes.
- OAuth client credentials, with a client secret, Basic auth or a private key JWT (Entra
  certificates).
- A refresh token, which Seti trades for access tokens and keeps the newest one of.
- A signed JWT (RFC 7523): Seti signs an assertion with the connection's private key and issuer
  and trades it for a token, as Salesforce and Okta take it. With no issuer, a Google service
  account key file supplies both, and Seti checks the file can sign when it is pasted.

For the OAuth kinds Seti mints a short-lived token, caches it until shortly before it expires and
mints again after a 401; Test mints one without showing it. A connection can be added without its
values, which the user fills in later; until then it says what it needs. Values are write-only:
Seti stores them sealed and never shows them again. Pollers send a connection by its name.

A credential is the bundle an agent picks, managed in Settings, Credentials. The built-in Default
holds what Seti had before credentials; more of them let different agents use different access. A
credential carries:

- Fine-grained GitHub tokens: a default one, and one per user or organization for repos the default
  cannot reach. Without one, agents reach GitHub anonymously.
- An AWS role that Seti assumes with the host's own AWS credentials, with the trust and
  permission policies to create it with.
- SSH hosts it bundles: every agent using it gets them, whatever its own Access says.
- Connections: each connection is switched on per credential, from either page, and a new one is in
  none.

Each agent picks a credential in the New agent dialog or its details; a change restarts its
session at the next turn. Credentials apply to sandboxed agents only: an unsandboxed agent uses the
host's own access. The EA may move an agent to another credential but never sees or edits one, and
it has no tool for connections.

### MCP servers for agents

Settings, MCP servers turns each server off or on by default for every agent without its own
choice, claude.ai connectors and plugin servers included. An agent can turn servers on or off for
itself in the Access list of the New agent dialog or the agent's details. Seti passes the servers an agent leaves out to Claude Code as denied servers, and a
sandboxed agent's proxy neither adds sign-in tokens for them nor reaches their connectors.

### Plugins for agents

Settings, Plugins lists two kinds of plugin. Seti defaults are local plugin folders (Local) that
Seti loads into its agents without changing Claude Code. Claude Code plugins live in
Claude Code's user settings, so the terminal and every agent see the same ones.

Add opens a searchable list of the plugins the configured marketplaces offer, with installed ones
marked. Opening one shows what its marketplace says it brings (skills, commands, agents, hooks, MCP
and LSP servers) and Install runs `claude plugin install <name>@<marketplace>` at user scope.
Plugins run third-party code on the host as the Seti user, so install only ones you trust. Each
installed plugin has an enable switch, Update and Uninstall. Marketplaces lists the marketplaces
Claude Code knows with their plugin counts; Add takes a GitHub `owner/repo`, a git URL or a local
path, and each one has Update and Remove. Built-in marketplaces can only be updated.

Running agents pick up a change in their next session. The page notices installs made with
`claude plugin` in a terminal on its own; Refresh reads everything again. Only the user changes
plugins and marketplaces: the EA and paired devices are refused, agents have no tool for it, and
the audit log records every change.

### Access: defaults and per-agent choices

Everything an agent may reach follows one model: each SSH host, AWS, MCP server, context
pack and Seti plugin has a Default switch in its settings page, and an agent's Access list, in the
New agent dialog or its details, turns any of them on or off for that agent alone, with a reset back
to the default. A choice equal to the default is not stored, so the agent follows later changes of
the default.

Settings, SSH lists the keys first, then the hosts that pick them. SSH keys are defined once: Seti
generates one, seals a pasted private key, or reads a key file on this machine (such as
`~/.ssh/id_ed25519`) when an agent needs it. A key's private half is never shown again. SSH hosts
each have an alias, address, port, the user ssh logs in as, one selected key, an optional jump host
(another host, chains allowed) and a short list of safe ssh options. A host is saved only with a
key, picked or made in its form, and a key's page lists its hosts and adds a new one with it. Check
host, once the host has a key, fetches its host keys to trust and logs in with that key from this
machine; saving a host with a key checks it too, and nothing contacts a host before. Each host pins
the host keys trusted after a check. Swapping a key's private half, by pasting a new key or pointing
it at another file, changes it for every host that selects it. Keys and hosts are renamed in place
from their page titles; renaming a host carries its credentials, defaults, agents' choices and
the hosts that jump through it to the new alias, and agents use the new name from their next turn.

An agent reaches a host when its Access turns the host on (or the host's Default does), or when its
credential bundles the host. A bundled host stays on for every agent using the set. Each jump
host on the way needs a key too; the Access dialog says when one is missing. The sandbox gets an
ssh config, known_hosts and its own ssh-agent with only the keys of its hosts, never a key file. New
hosts and AWS start off by default. Deleting a host drops its default, every agent's choice for it
and its place in any set. Changes restart the affected sessions at their next turn.
AWS uses the role of the agent's credential, and picking a set with a role turns AWS on
for that agent. The agent's settings keep only its grants and a link to its credential, where
what the set holds is managed. The EA may read hosts, the sets that
bundle them and an agent's SSH hosts and AWS but never change them, keys or trusted host keys.

The upgrade that brought hosts and logins turns the old free-text ssh config into hosts and gives
Default a login for each, with the block's User and the key the old shared agent most likely used;
the audit log's `system.ssh_migrated` event lists every guess and every dropped line. The next
upgrade moves each login onto its host. When credentials logged in to one host differently, the
login of Default (or of the most sets) keeps the alias and each other login becomes a copy of the
host named after its user, such as `k8s-ubuntu`. Every agent keeps the hosts it reached, through
its own Access choices.

### Backups

Seti streams `pg_dump` into encryption to a public key, so the host cannot read its own backups.
Create the key pair once, keep the private key off the host, and add the printed line to
`~/.seti/seti.env`:

```sh
pnpm --filter @seti/server backup keygen /absolute/path/seti-backup.key
```

After a restart Seti writes `~/.seti/backups/seti-<time>.pgdump.enc` every
`SETI_BACKUP_INTERVAL_HOURS` and keeps the newest `SETI_BACKUP_KEEP`. `backup now --env-file
~/.seti/seti.env` takes one on demand. A restore goes into a new database and verifies its audit
chain; point `SETI_DATABASE_URL` at it, or rename it over `seti` while Seti is stopped:

```sh
pnpm --filter @seti/server backup restore /abs/backup.pgdump.enc seti_restored --key /abs/seti-backup.key
```

A restored database also needs the secret store key; see [Security](security.md).

## Upgrading

```sh
~/seti/scripts/upgrade.sh
```

Seti checks `origin/main` itself: Settings, About says when main has commits the running version
lacks, lists what changed, and shows this command.

It refuses a checkout with local changes, fetches `origin/main` (`--ref` picks another), and then:

1. Fast-forwards the branch, or moves a detached checkout, to the new commit.
2. Runs `pnpm install --frozen-lockfile` and `pnpm build`, and `uv sync` when the EA is set up.
   When the build fails, it puts the previous commit back and stops; the running Seti is untouched.
3. Rewrites the units the installer wrote, so they follow changes to `deploy/`.
4. Dumps the database to `~/.seti/pg-dumps/seti-<time>-<previous commit>.pgdump`, owner-only,
   keeping the newest 10 of its own dumps.
5. Restarts `seti.service` and `seti-ea.service`. Seti applies new migrations as it starts.
6. Runs `deploy/health-check.sh`: ping, a refused call without the token, an accepted one with it.
   When that fails, it rebuilds and restarts the previous commit and prints the `pg_restore`
   command for the dump, for the rare upgrade whose migrations the old version cannot read.

`--no-restart` only installs and builds; `--no-backup` skips the dump. Without systemd it builds
and tells you to restart `scripts/start.sh`. It works the same from a separate detached worktree,
such as a live instance in `~/seti-live` next to a development clone in `~/seti`, and with units
you wrote yourself, which it restarts but never rewrites.

To go back by hand: check the previous commit out, `pnpm install --frozen-lockfile && pnpm build`,
restart the service, and restore the dump if the newer version changed the schema:

```sh
systemctl --user stop seti.service
pg_restore --clean --if-exists --no-owner -d 'postgresql:///seti?host=/var/run/postgresql' ~/.seti/pg-dumps/<dump>
systemctl --user start seti.service
```

## Uninstalling

```sh
systemctl --user disable --now seti.service seti-ea.service cloudflared.service
rm -f ~/.config/systemd/user/{seti,seti-ea,cloudflared}.service
systemctl --user daemon-reload
dropdb seti                        # deletes every task, transcript and setting
rm -rf ~/.seti ~/seti              # data, secrets, agent worktrees and the clone
```

Keep `~/.seti/credentials/secret-key` and a database dump if you might come back. Optional system
pieces stay installed: `sudo systemctl disable --now seti-redis@$USER`, `sudo rm
/etc/apparmor.d/bwrap`, `sudo loginctl disable-linger $USER`, and the apt packages. `~/work` holds
the checkouts agents made; delete it once nothing there matters.

## Troubleshooting

Start with the doctor. It checks Node, pnpm, uv, the build, the secrets (by size and mode, never
their values), PostgreSQL and migrations, Redis, the sandbox, memory and CPU caps, Claude Code and its
login, `gh`, the ports, the units and the EA keys, and prints a fix under each problem. It exits
with 1 when Seti cannot work.

```sh
cd ~/seti && pnpm run doctor
```

| Symptom                                                                 | Fix                                                                                                           |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Agents fail to start: `bwrap cannot create user namespaces`             | Ubuntu 23.10+ restricts them; run the installer again, which adds the AppArmor profile below                  |
| `seti.service` restarts in a loop                                       | `journalctl --user -u seti.service -n 100`; a missing credential or a bad setting is named in the first error |
| `Seti needs the credential ...`                                         | Run `scripts/install.sh` again; it creates missing secrets and never overwrites one                           |
| `role "<you>" does not exist` or `permission denied to create database` | `sudo -u postgres createuser --createdb "$USER"`                                                              |
| The browser shows `Unexpected Host header`                              | Open `http://seti.localhost:3006`, or set `SETI_PUBLIC_URL` to the proxy's origin                             |
| `Cross-origin request` on every save behind a proxy                     | `SETI_PUBLIC_URL` must match the address bar exactly                                                          |
| Seti stops when you log out                                             | `sudo loginctl enable-linger "$USER"`                                                                         |
| `No Claude login found`                                                 | `claude`, then `/login`; or `claude setup-token` and paste the token in Settings, Credentials                 |
| PRs never show up                                                       | `gh auth login`                                                                                               |
| Port 3006 is taken                                                      | Set `SETI_PORT` in `~/.seti/seti.env`, or run the installer with `--port`                                     |
| macOS: every agent fails to start                                       | Turn the sandbox off in Settings, Sandbox; bubblewrap is Linux-only                                           |

### Sandbox

Ubuntu 24.04 restricts unprivileged user namespaces, which bubblewrap needs. When
`sysctl kernel.apparmor_restrict_unprivileged_userns` prints `1`, the installer adds this profile;
by hand:

```sh
sudo tee /etc/apparmor.d/bwrap >/dev/null <<'EOF'
abi <abi/4.0>,
include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
  include if exists <local/bwrap>
}
EOF
sudo apparmor_parser -r /etc/apparmor.d/bwrap
bwrap --unshare-user --unshare-pid --unshare-net --ro-bind / / --dev /dev --proc /proc true && echo sandbox ok
```

A task fails to start when the sandbox does not work; it never falls back to running unsandboxed.

## Why there is no Docker image

The sandbox is the point of Seti's security model: every agent runs in bubblewrap with its own user,
PID and network namespaces behind a per-task egress proxy, inside a systemd scope that caps its
memory and CPU. In a container, bubblewrap needs unprivileged user namespaces, which Docker's default
seccomp and AppArmor profiles block; making it work takes `--privileged`, or `CAP_SYS_ADMIN` with
seccomp and AppArmor unconfined, and the memory caps need a systemd user manager inside the
container as well. That trades the container's isolation away to get the sandbox back, so the image
would protect nothing a native install does not. Seti also works on the host itself: your repos, git
worktrees, Claude Code login and SSH, all of which a container would have to bind-mount from the
home directory anyway. The native install is the supported path. PostgreSQL can still run in a
container: pass its URL with `--database-url`.

## Manual install

The installer automates these steps; do them by hand on a machine it does not cover.

```sh
sudo apt-get install postgresql bubblewrap socat openssl util-linux openssh-client git gh curl \
  build-essential python3 jq ripgrep fd-find
sudo apt-get install --no-install-recommends poppler-utils ffmpeg librsvg2-bin \
  libreoffice-writer-nogui libreoffice-calc-nogui libreoffice-impress-nogui   # optional: share previews
sudo -u postgres createuser --createdb "$USER"
nvm install 24 && corepack enable pnpm             # Node 24 with pnpm
curl -fsSL https://claude.ai/install.sh | bash      # Claude Code, then: claude, /login
git clone https://github.com/rickaym/seti.git ~/seti && cd ~/seti
pnpm install --frozen-lockfile && pnpm build
mkdir -m 700 -p ~/.seti && deploy/migrate-secrets.sh --no-units   # secrets, never printed
echo SETI_REDIS_URL=off >> ~/.seti/seti.env
scripts/start.sh                                    # or the units, as the installer writes them
```

`deploy/migrate-secrets.sh` also moves keys out of the `*.env` files of installs older than the
credential files; see [Security](security.md#rolling-back-past-the-secret-store).

## Development

```sh
NODE_ENV=development pnpm start
```

Development mode creates its own secret store key and local tokens in `~/.seti/dev-credentials`;
sign in with `~/.seti/dev-credentials/local-token-user`.

| Command            | What it does                                          |
| ------------------ | ----------------------------------------------------- |
| `pnpm dev:server`  | API with reload on :3006, in development mode         |
| `pnpm dev:ui`      | Vite on :5173, proxying `/api` to :3006               |
| `pnpm check`       | format, text, types, lint, knip, tests, EA checks, UI |
| `pnpm e2e`         | Playwright suite, after `pnpm build`                  |
| `pnpm screenshots` | Retakes the README screenshots from seeded demo data  |
| `pnpm run doctor`  | Checks this machine and the install                   |

Tests clone a template database per test file on the local PostgreSQL (or the server
`SETI_TEST_DATABASE_URL` names) and drop it afterwards; the e2e suite starts its own Seti per
worker with a scratch home, database and tokens. Neither touches a running instance.

To run a second instance next to a live one, give it its own home, port and no shared Redis. A
different `SETI_HOME` gets its own database, named after that directory:

```sh
NODE_ENV=development SETI_HOME=/tmp/seti-scratch SETI_PORT=3106 SETI_REDIS_URL=off pnpm start
```

## Where data lives

| Path                         | Contents                                                        |
| ---------------------------- | --------------------------------------------------------------- |
| `~/.seti/credentials/`       | Service secrets, one 0600 file each                             |
| `~/.seti/dev-credentials/`   | The same for development and test runs                          |
| `~/.seti/seti.env`, `ea.env` | Non-secret settings of Seti and the EA                          |
| `~/.seti/pg-dumps/`          | Database dumps `scripts/upgrade.sh` takes before a restart      |
| `~/.seti/worktrees/`         | Agent worktrees                                                 |
| `~/.seti/workspace/<task>/`  | Each agent's workspace of live Markdown files                   |
| `~/.seti/sandbox/`           | Per-task sandbox homes and each task's ssh-agent socket         |
| `~/.seti/sandbox-ca/`        | The name-constrained CAs the egress proxy signs with            |
| `~/.seti/backups/`           | Encrypted database backups                                      |
| `~/.seti/pre-credentials-*/` | Env files and units as `migrate-secrets.sh` found them          |
| PostgreSQL database `seti`   | Tasks, transcripts, PRs, channels, the audit log, sealed tokens |
| `~/.claude/projects/`        | Claude Code sessions, which Seti resumes                        |
| `~/work/`                    | New clones and worktrees agents make                            |

Seti keeps `~/.seti` owner-only and tightens anything more open at startup.
