# Installing Seti

TLDR: on Linux, run the one-line installer. It checks the machine, installs what is missing
(asking before anything that needs sudo), builds Seti, writes its settings and secrets, and runs it
as a systemd user service on `127.0.0.1:3006`. Open `http://seti.localhost:3006` and sign in with
the token in `~/.seti/credentials/local-token-user`. `scripts/upgrade.sh` updates it later, and
`pnpm seti:doctor` says what is wrong and how to fix it.

```sh
curl -fsSL https://raw.githubusercontent.com/rickaym/seti/main/scripts/install.sh | bash
```

## Quickstart

1. Run the installer as the user Seti should run as (not root). From a clone, run
   `scripts/install.sh` instead; through curl, it clones Seti to `~/seti` first.
2. When it finishes, open a new shell so it finds the tools the installer added to `~/.local/bin`
   and nvm, then log in to Claude Code (`claude`, then `/login`) and to GitHub (`gh auth login`).
   Agents use your Claude login; Seti lists and watches your PRs, in any repo, with your `gh`
   login.
3. Open `http://seti.localhost:3006`. From another machine, forward the port first:
   `ssh -L 3006:127.0.0.1:3006 <host>`.
4. Sign in with the local token: `cat ~/.seti/credentials/local-token-user` and paste it. The
   browser keeps an HttpOnly session cookie for 30 days.
5. In Settings, check the Claude login under Runtimes and the sandbox under Sandbox. An agent
   starts in a fresh folder of its own under `~/work` and clones the repos it needs, so there is
   no repo or directory to pick first.

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
| `--split-node`         | Runs agents in a separate node unit (see Separate node below)          |
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
on `127.0.0.1` only. Logs are in `journalctl --user -u seti.service`; a request that ends in a
server error is logged with its method, route, status and error, never its body, query or headers.

The installer writes its units from `deploy/seti.service` and `deploy/seti-ea.service`, with the
clone's path, your Node and a marker line. It never replaces a unit file that lacks the marker, so
a hand-made unit stays as it is. Without systemd (macOS, containers), run Seti in the foreground:

```sh
~/seti/scripts/start.sh
```

Outside systemd, Seti reads its secrets from `~/.seti/credentials` (or `SETI_CREDENTIALS_DIR`)
itself. A production run never creates a secret; the installer does.

## Signing in

On loopback (`seti.localhost`, `localhost`, `127.0.0.1`) the local token always works, so it is
the way back in. On the public hostname (`SETI_PUBLIC_URL`) Seti takes a passkey session, or a
Cloudflare Access login it verifies itself when Access guards the hostname (API-9 in
[the protocol](protocol.md#19-client-contract)). Add passkeys in Settings, Sign-in from a browser
that is already signed in; `pnpm setup-code` on the host prints a one-time code that enrolls the
first passkey from anywhere.

Scripts send the token with curl's `-K`, so it stays out of the process list:

```sh
curl -s -K <(printf 'header = "Authorization: Bearer %s"\n' "$(cat ~/.seti/credentials/local-token-user)") \
  http://127.0.0.1:3006/api/system
```

To sign every browser out, rotate the token: see [Security](security.md#rotating).

## Sharing to Seti from a phone

On Android, Seti appears in other apps' share menus once the Seti app is paired, or once Seti is
installed as a web app from Chrome (Install app); a web app installed before share support must be
removed and installed again. A share opens Seti's Share page with the files as attachments and any
text in the message box; pick an agent, or New agent, and Send. The share stays in the browser's
cache on the phone until you send it, under the limits of Attach: 25 MB a file, 20 files and 50 MB
a message. iOS has no web share targets, so on an iPhone save the file to Files and use Attach.

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

An attached file uploads as one request of at most 25 MB. Seti gives an upload 30 minutes while
bytes keep arriving and gives it up after 60 seconds without any. The proxy must accept a body of
that size and must not end a request that is still sending: Caddy sets neither limit, nginx needs
the `client_max_body_size` line above, and a proxy with a timeout for the whole request needs it
long enough for a slow phone link. The reply box refuses a larger file before sending it, and
when a proxy refuses or cuts an upload it says so on the file.

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

Settings, JSON shows every setting Seti keeps in its database as one JSON document, the same
values the other settings pages show: search it, copy a section or export the whole document.
Secrets appear only as `set` or `not set`, and the page only reads; each setting changes on its
own page. `GET /api/settings-doc` serves the document and `GET /api/settings-doc/schema` its
JSON Schema.

Settings Seti reads at start live in `~/.seti/seti.env` (one `NAME=value` per line) and secrets in
`~/.seti/credentials`, one owner-only file each. Restart Seti after a change:
`systemctl --user restart seti.service`. `pnpm seti:doctor` reads the same file and reports a value
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
| `SETI_SCRATCH_ROOT`                                | `~/work`                     | Where each new agent gets its own folder                          |
| `SETI_SOURCE_DIR`                                  | the clone Seti runs from     | The checkout whose git history What's new reads                   |
| `SETI_SESSION_IDLE_MINUTES`                        | `15`                         | How long an idle agent's process stays open                       |
| `SETI_NODE`                                        | unset                        | `split` runs agents in a separate node process (`start-node`)     |
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
| `SETI_MCP_REGISTRY_URL`                            | MCP Registry                 | Where Add server searches, registry.modelcontextprotocol.io       |
| `SETI_SAFE_MODE`                                   | unset                        | `1` keeps every third-party mod off, whatever Settings, Mods says |
| `NODE_ENV`                                         | unset                        | `development` makes a run create its own secrets (see below)      |
| `SETI_DEV_CREDENTIALS_DIR`                         | `SETI_HOME/dev-credentials`  | Secrets of a development or test run                              |
| `SETI_TEST_MODS`                                   | unset                        | `1` loads the mods Seti's own tests use, in a development run     |

`SETI_CLAUDE_BIN` defaults to a working `claude` on PATH, else the binary the Agent SDK ships.
Without `SETI_DATABASE_URL`, a `SETI_HOME` other than `~/.seti` gets its own database, named after
the directory, so a scratch instance never shares the live one.

The memory cap of an agent has no environment variable: it follows the host (`mem_cap` in
[Appendix A](protocol.md#appendix-a-reference-constants)) until you save one in Settings,
Resources. A larger cap means fewer `tsc` runs stopped at it and more risk when several agents
peak together. [Implementation](implementation.md#reference-values) lists the other protocol
values an install can change.

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
| `EA_THINK_MODEL`, `EA_THINK_EFFORT`                   | `gpt-6-sol`, `medium`     | The reasoning model the think tool hands hard questions to |
| `ELEVENLABS_VOICE_ID`, `ELEVENLABS_MODEL`             | a set voice, flash v2.5   | The voice; another model must speak the EA's language      |
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
`SETI_SDK_MODULE`, `SETI_TERMINAL_SHELL`, `SETI_CODEX_PIN`, `SETI_PROBE_DELAY_MS`,
`SETI_PR_POLL_MS`, `SETI_AWAY_MS` and the `SETI_E2E_*` variables; production ignores the loopback,
upstream, module, terminal shell, Codex pin, probe, poll and away ones.

## Optional pieces

### Executive Assistant

The EA is a Python process (pipecat) on `127.0.0.1:3007`. `scripts/install.sh --with-ea` installs
uv, the EA's dependencies and its wake word model (about 9 MB, in `~/.cache/seti-ea/models`), asks
for the keys without echoing them, and starts `seti-ea.service`. The chat needs only the OpenAI
key; calls also need Deepgram and ElevenLabs, and the TURN keys for calls from other networks.
`GET /api/ea/health` lists missing keys, and Settings, EA holds the wake word, audio devices,
models and Address as: the title or name the EA calls you now and then, empty for no title, which
is the default.

Language on the same page sets what the EA listens, speaks and writes in: English, one of the 31
other languages both Deepgram Nova-3 and ElevenLabs Flash v2.5 cover, or Multilingual. The wake
phrase stays in English words, since the wake word model knows only English sounds.

To add a key later, write it to its file and restart both services:

```sh
(umask 077; printf '%s\n' 'sk-...' > ~/.seti/credentials/openai-api-key)
systemctl --user restart seti.service seti-ea.service
```

A call keeps going while Seti is in the background, as when you switch apps on a phone, and ends
only once the browser declares the network path failed, after about 30 seconds. Each call end is
audited as `ea.call_ended` with its reason and length, never audio or words.

On Android, Chrome sends call audio to a Bluetooth headset only when Chrome may use Nearby devices
(Android settings, Apps, Chrome, Permissions). A headset that connects mid-call takes over once the
device list settles, and the Audio button in the call does the same on demand.

### Separate node

`--split-node` sets `SETI_NODE=split` and installs `seti-node.service` (from
`deploy/seti-node.service`), which runs `scripts/start.sh node`: the agents' sessions run in that
process, and `seti.service` reaches them over `~/.seti/run/node.sock`, a socket in a folder only
your user may enter. A restart of `seti.service` then keeps running turns going.
`scripts/upgrade.sh` restarts the node only when the code the node runs or the package files
changed (`pnpm --dir server run build-id` prints the id it compares), and Seti records the node's
running turns before the node cuts them. `pnpm seti:doctor`
checks the socket. Logs are in `journalctl --user -u seti-node.service`.

Split mode still has gaps that a single process does not:

- The node still reads some settings from the database itself. It reads no secret value and runs
  without the secret store key.

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

New connection starts at a list of services to pick by name. Each one asks only for what that
service needs, in the service's own words, and fills in the hosts, header, token URL and scope:

- Microsoft Entra app: the Directory (tenant) ID, the Application (client) ID and a client secret.
  A token is for one API, so each API ticked (Microsoft Graph, Azure Resource Manager, Key Vault,
  Azure Storage) becomes its own connection with the same app.
- Google service account: the JSON key file, the APIs to reach (Admin directory, Gmail, Drive,
  Sheets, Calendar, Cloud Platform) as one connection, and optionally the Workspace user to act as
  under domain-wide delegation. Each API asks for its read-only scope until its Write switch is on.
- Services that take one key, such as OpenAI, ElevenLabs, Stripe, Slack, Cloudflare, Linear, Notion
  and Sentry. Twilio and Jira Cloud take the key as a Basic auth password, which the agent sends
  and the proxy swaps in.

Custom opens the form with every field for a service the list does not have. The list is
`shared/src/connection-key-services.ts` and `shared/src/connection-template-list.ts`.

A connection is one service's access, made in Settings, Connections: its name, the hosts it may
reach (exact or `*.suffix`), how Seti signs in, and the values that takes. Agents see its variable,
such as `STRIPE`, holding a placeholder that the proxy swaps for the value on those hosts only, in
the URL and headers (EGR-5 in [the protocol](protocol.md#73-egress)). It never swaps a value into a
request body, and refuses a request that carries a placeholder in its body unsent (EGR-14). With
"Seti adds it" on, the proxy also sets a header from a template (`Bearer {{value}}`) on every
request to those hosts (EGR-7). A connection signs in one of four ways:

- A key the user pastes.
- OAuth client credentials, with a client secret, Basic auth or a private key JWT (Entra
  certificates).
- A refresh token, which Seti trades for access tokens and keeps the newest one of.
- A signed JWT (RFC 7523): Seti signs an assertion with the connection's private key and issuer
  and trades it for a token, as Salesforce and Okta take it. With no issuer, a Google service
  account key file supplies both, and Seti checks the file can sign when it is pasted.

For the OAuth kinds Seti mints a short-lived token and mints again after a 401; Test mints one
without showing it. A connection can be added without its values, which you fill in later. Values
are write-only. Pollers send a connection by its name.

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

Each agent picks a credential in the New agent dialog or its details; a change applies from its
next turn. Credentials apply to sandboxed agents only (SEC-1 in
[the protocol](protocol.md#8-secrets-and-connections)); an unsandboxed agent uses the host's own
access.

### MCP servers for agents

Settings, MCP servers turns each server off or on by default for every agent without its own
choice, claude.ai connectors and plugin servers included. An agent can turn servers on or off for
itself in the Access list of the New agent dialog or the agent's details, and Seti denies the rest
to that agent (EGR-12 in [the protocol](protocol.md#73-egress)).

Add server opens a catalog of common connectors and searches the
[MCP Registry](https://registry.modelcontextprotocol.io) (`SETI_MCP_REGISTRY_URL`); picking one
fills the form, and the values stay yours to enter. Google Workspace servers take your own OAuth
client; Seti passes its secret to `claude mcp add` through `MCP_CLIENT_SECRET`, never on the
command line. Servers that sign in with OAuth show Sign in once added.

### Plugins for agents

Settings, Plugins lists two kinds of plugin. Seti defaults are local plugin folders (Local) that
Seti loads into its agents without changing Claude Code. Claude Code plugins live in
Claude Code's user settings, so the terminal and every agent see the same ones.

Add lists the plugins the configured marketplaces offer, and Install runs
`claude plugin install <name>@<marketplace>` at user scope. Plugins run third-party code on the host
as the Seti user, so install only ones you trust. Marketplaces takes a GitHub `owner/repo`, a git
URL or a local path. Running agents pick up a change in their next session.

### Shared tools

A script an agent wrote that proved useful can become a shared tool every agent can call
([section 9 of the protocol](protocol.md#9-shared-tools)). The agent proposes it, the request card
shows the whole script, and Allow publishes it. Settings, Plugins lists the shared tools with who
proposed each one and when; Code shows the arguments and the script, the switch turns a tool off
for every agent, and Remove deletes it. A script reads its arguments as one JSON object on stdin,
prints its result to stdout, and is stopped after 120 seconds unless the proposal sets up to 600.

### Codex agents

Agents run on Claude Code. An agent can run on OpenAI's Codex instead; Codex is off by default,
and only you change that.

1. In Settings, Runtimes, turn Codex on. Seti installs the version it is built for into
   `~/.seti/codex/<version>/` and checks it first (RT-11 in [the protocol](protocol.md#35-runtime));
   the status reads Installing, then No key.
2. In Settings, Connections, add a connection with your OpenAI key for `api.openai.com`, with the
   header `Authorization: Bearer {{value}}`, in the default credential. The status reads Ready.
   The agent holds a placeholder; the egress proxy puts the key on requests to OpenAI's API only.
3. On the start page, pick a Codex model in the Model selector beside the message box, and an
   effort if you want one, then start the agent. The selector lists Codex models only while the
   status reads Ready.

When an upgrade moves the pinned version, Seti installs the new one at its start and removes the
old one once no agent runs it. With a separate node (`SETI_NODE=split`), `seti.service` installs
it; the node starts the program at the path the server hands it with each agent's spec, from the
same `~/.seti`, and mounts its folder read-only into the sandbox as a single process does.

On a machine without network access, put a `codex` program of the pinned version somewhere and
name it under Advanced, Own program, in the Codex card; the status says when it is missing or
another version. `pnpm seti:doctor` shows a Codex line while Codex is on.

A Codex agent runs only in the sandbox. Seti's rules answer its calls: a guard or deny rule
refuses at once, an allow rule or Seti's read-only list runs the call, and every other command,
edit and tool call asks you. A call to one of your tool servers runs without asking only when an
allow rule of yours names that server or tool. Turn Rules decide off in the Codex card under
Settings, Runtimes to answer every call yourself; an upgrade keeps the choice you made. A Codex
agent shows a summary of its reasoning where a Claude agent shows its thinking, which costs a few
output tokens per model call. Codex agents have no side chat, rewind, Bypass or plugins. Their
cost is an estimate from the price table in
`server/src/runtimes/codex/prices.ts`, which names the day it was read; to update it, copy the
standard rates from OpenAI's pricing page into that table, set `asOf` to the day, and run
`pnpm check`.

With both runtimes set up, any agent with Seti control can ask the other one for a second
opinion with its `second_opinion` tool: a Claude agent asks Codex, a Codex agent asks Claude.
The other model answers once, with no tools and none of the agent's folders, in a sandbox that
reaches only its provider with the agent's credential, so the credential needs that runtime's
key. The transcript shows one row, "Asked gpt-5.5: ...", that opens to the question and answer;
its cost counts toward the agent's and shows under Cost in its settings. An agent may ask 20
times an hour and 60 a day.

### Access: defaults and per-agent choices

Everything an agent may reach follows one model: each SSH host, AWS, MCP server, context
pack and Seti plugin has a Default switch in its settings page, and an agent's Access list, in the
New agent dialog or its details, turns any of them on or off for that agent alone, with a reset back
to the default. A choice equal to the default is not stored, so the agent follows later changes of
the default.

Settings, SSH holds keys and hosts. Seti generates a key, seals a pasted private key, or reads a
key file on this machine (such as `~/.ssh/id_ed25519`) when an agent needs it, and never shows a
private half again. A host has an alias, address, port, login user, one key, an optional jump host
and a few safe ssh options; Check host fetches its host keys to pin and logs in once, and nothing
contacts a host before that. An agent reaches a host when its Access or the host's Default turns
it on, or when its credential bundles the host, and every jump host needs a key too (EGR-10 in
[the protocol](protocol.md#73-egress)). New hosts and AWS start off. AWS uses the role of the
agent's credential. An install upgraded from free-text ssh config had its hosts made from that
config; the audit log's `system.ssh_migrated` event lists every guess and every dropped line.

### Permission requests

Settings, Permissions holds the permission rules and the Request timeout, 1 h by default; a request
nobody answers in that time is denied as timed out (PERM-7 and PERM-8 in
[the protocol](protocol.md#74-permission-rules-and-requests)). Off keeps a request waiting until
you answer it.

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

### Storage

Settings, Storage shows what each agent's folders take on disk, largest first, with the total
and the disk's free space at the top. Each agent's folders are its folder in `~/work`, its
worktrees, its workspace and its sandbox (`~/.seti/sandbox/<task>`), plus any checkout it was
given. Sizes come from a walk in the background that stops after 400,000 entries or 20 seconds
per folder; a size it cut short reads "about". An agent's name opens its Files view as a tree,
one level at a time, with each folder's size, a git badge on repositories and a "rebuildable"
mark.

Rebuildable folders are what a reinstall, a build or the tool that made them makes again:
`node_modules`, virtualenvs (`.venv` or `venv` with a `pyvenv.cfg`), `__pycache__`, tool caches
such as `.pytest_cache`, `.next`, `.turbo`, `.gradle`, `.cache` and `.npm`, and a sandbox's
`/tmp`. Build output (`dist`, `build`, `target`, `coverage`) counts only inside a git repository
that ignores it.

- Clean, on each agent's row, lists the rebuildable folders it would remove with their sizes and
  removes them once you confirm. It works only in folders Seti made for the agent, never in a
  checkout you gave it, never on a folder git tracks files in, and never while the agent runs.
- Orphans lists folders in Seti's folders that no agent owns, such as those of deleted agents
  and failed starts, and worktree records whose folder is gone. A folder that changed in the last
  hour, or holds a repository with uncommitted changes or unpushed commits, stays; copy its path
  to look at it in a terminal.
- Automatic clean is off until you turn it on. Then an hourly sweep cleans the agents idle longer
  than 7, 14 or 30 days, archived agents included, and records what it freed.

Every removal is in the audit log with the folder, its path there and the bytes freed. The EA
can read this page and an agent's tree, and clean one agent once you say yes; only you remove
orphans or change the automatic clean (RES-16 to RES-19 in
[the protocol](protocol.md#15-resilience)).

## Channels: webhooks, pollers and reminders

Settings, Channels holds the sources of events: webhooks that apps send, pollers for services that
send none, and reminders. All three feed one event path with the same subscribers, filters,
delivery log and agent updates ([section 10 of the protocol](protocol.md#10-inbound-events)). No
model runs for a channel; only an event wakes the EA or a subscribed agent.

Each agent's subscription says when it gets an update: Agent default (the agent's Updates
setting), Now, After turn or With message, which are the timings of UPD-2 in
[the protocol](protocol.md#5-updates-and-delivery). The channel's subscriber list and the
Channels row of the agent's settings both set it, and the EA and agents set it with the `delivery`
argument of `subscribe_channel`. Only you give a poller extra hosts or secrets,
describe a custom sender, paste a webhook secret or check a sample (CHN-19); the EA and agents at
Seti control Full create and change the rest, the EA after your yes.

### Webhook senders

New, Webhook starts with a picker of the apps that can send. Each app is a sender: a description,
as data, of how it signs a delivery and where its event name, title and link are. The picker lists:

- The catalog in `shared/src/webhook-sender-catalog.ts`: Linear, Bitbucket, Cloudflare, GitLab,
  Grafana, Jira, Make, PagerDuty, Shopify, Slack, Standard Webhooks, Stripe, Svix, Vercel and
  Zapier.
- Senders a mod adds with its own code, such as GitHub and Sentry, which also track states.
- Seti signature, for a sender that can sign with `X-Seti-Signature` or send a bearer secret.
- Custom, at the foot of the picker, for an app the catalog does not list, with the fields below.

After Create, Seti shows the URL to paste into the app with the app's own setup steps. An app that
issues the secret, as Linear does once it has the URL, gets a field for it in the same dialog, and
the webhook refuses deliveries until the secret is saved. Where the app lets you set the secret,
Seti makes one and shows it once. Behind Cloudflare Access, `/hooks/` needs a Bypass application
([Cloudflare Tunnel and Access](#cloudflare-tunnel-and-access)).

| Field                     | What it says                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------ |
| `signature.scheme`        | `hmac` for a signature, or `token` for an app that sends the secret itself in a header           |
| `signature.header`        | The header with the signature or the token                                                       |
| `signature.algorithm`     | `sha256`, `sha1` or `sha512`                                                                     |
| `signature.encoding`      | `hex` or `base64`                                                                                |
| `signature.prefix`        | What a signature starts with, such as `sha256=`, `v1=` or `v1,`; other entries are skipped       |
| `signature.separator`     | `none`, or `comma` or `space` for a header with several signatures; one match is enough          |
| `signature.signed`        | `{body}`, `{timestamp}.{body}`, `v0:{timestamp}:{body}` or `{id}.{timestamp}.{body}`             |
| `signature.key`           | `text` uses the secret's characters; `base64` its decoded bytes, after any `whsec_`              |
| `timestamp`               | Where the sending time is: a header, a body field, or a part of the signature header such as `t` |
| `max_age_s`               | How old the timestamp may be, 300 seconds unless set                                             |
| `id`                      | Where the delivery id is: a header or a body field                                               |
| `secret`                  | `sender` when the app issues the secret, `generated` when Seti makes it                          |
| `event`, `action`         | Where the event name is, and a body field appended after a dot, as in `issue.create`             |
| `title`, `link`, `detail` | Body fields tried in order for the update's title, link and text                                 |
| `detail_max`              | How many characters of the text, or of the payload when no field holds text, are passed on       |
| `handshake`               | A signed URL check to answer: the field and value that mark it and the field to send back        |

A body field is a dot path such as `data.title` or `alerts.0.labels.alertname`. A timestamp is
read as epoch seconds, epoch milliseconds or an ISO time. An update's title falls back to the
sender and the event name, and its link is kept only when it is an http or https URL.

Linear, for example, signs the raw body with HMAC-SHA256 in `Linear-Signature`, carries
`webhookTimestamp` in milliseconds and sends a `Linear-Delivery` id; its entry in the catalog file
sets those three, `max_age_s: 60`, the event from `type` and `action`, and title, link and detail
paths. In Linear, Settings, API, New webhook takes the URL, and the webhook's page then shows the
signing secret to paste into Seti. A new issue arrives as `issue.create`, so a subscription
filtered to `issue` takes every issue event and one filtered to `issue.create` only new issues.

Sample, on the card of a webhook with a catalog or custom sender, takes the headers and body of a
request copied from the app's delivery log and says whether the signature verifies and what event,
title and link it would produce; it stores nothing and reaches no subscriber. A captured request
is usually older than `max_age_s`, so the answer says a live delivery that old would be refused.
The card's Activity lists every request with why it was refused: `missing signature`,
`signature mismatch`, `token mismatch`, `too old`, a duplicate delivery id, or a secret that is not
pasted yet.

A sender is data only while a shared secret and one of the four signed templates verify it. These
need a mod instead: Twilio (signs the URL and form fields), Discord (Ed25519 and a typed reply),
Zoom (a computed reply to its URL check), Notion (an unsigned token request), Intercom (a HEAD URL
check), Twitch EventSub (no separators in the signed text) and Supabase Auth hooks (a reply body).
[Mods](mods.md#channel-sources) shows how to write one.

### Webhook filters

A filter is a short piece of JavaScript that runs on each verified delivery before any subscriber
or the EA sees it, for when a webhook sends more than you want (CHN-32). Add, in the Filter row of
the webhook's card, opens the editor with the full contract under Filter API. The function gets the event as
the sender produced it: `event` (such as `issue.create`), `action`, `title`, `link`, `detail`,
`headers` (a few that name the event, such as `x-github-event`; never a signature or token) and
`payload`, the parsed body. It returns `false` or `null` to drop the delivery, `true` to keep it,
or an object that replaces any of `event`, `title`, `link` and `detail`. It may be async, and
`log(...)` writes lines that Test shows.

Drop Linear issue events that are not assigned to you, where `ME` is your Linear user id (the
`id` that Linear's GraphQL query `{ viewer { id } }` returns):

```js
const ME = 'your-linear-user-id'

export default function filter({ event, payload }) {
  if (!event.startsWith('issue')) return true
  return payload.data?.assigneeId === ME
}
```

Keep only failed GitHub check runs, with a title that says which:

```js
export default function filter({ event, payload }) {
  if (event !== 'check_run.completed') return false
  const run = payload.check_run
  if (run.conclusion !== 'failure') return false
  return { title: `${run.name} failed in ${payload.repository.full_name}`, link: run.html_url }
}
```

Test runs the code as edited against the newest 20 deliveries and, optionally, a request pasted
under Sample, and shows for each whether it would be kept, changed, dropped or fail, with the log;
it stores and sends nothing. The switch beside Filter turns the filter off without losing the
code, and clearing the code and saving removes it.

The card shows what the filter did over the last 24 hours. Activity marks a dropped delivery as
`filtered out` and one the filter reshaped as `changed by filter`. A filter that throws, runs past
its second, uses more than 32 MB or returns anything else never loses a delivery: the delivery goes
on unchanged, Activity says `filter failed` with the error, and after three failures in a row the
card shows a warning until a run succeeds or the code changes. The EA, after your yes, and agents
at Seti control Full may write a filter, as they may a poller script without secrets; every change
is in the audit log with a hash of the code, and `update_channel` and `test_channel_script` carry
the same contract for them.

### Pollers

New, Poller starts from a template that stays a plain script to edit: Blank is Seti's own, and
HTTP JSON and RSS/Atom feed come from the bundled Poller templates mod. A poller keeps its own copy
of the script, so turning that mod off stops no poller.

```js
export default async function poll({ fetch, parseFeed, log, state, since }) {
  const res = await fetch('https://api.example.com/items', {
    secretHeaders: { Authorization: 'Bearer {{my_token}}' },
  })
  const data = await res.json()
  return data.items.map((item) => ({ key: String(item.id), title: item.name, url: item.url }))
}
```

The script returns an array of items, or `{ items, state }` to keep up to 16 KB of JSON for the
next run. An item has `key` (required, a stable id) and optionally `title`, `kind`, `url`, `body`
or `summary`, `fields` (an object) and `fingerprint`. It runs with no Node APIs, files,
environment, timers or CLIs, only what it is given (CHN-12):

- `fetch(url, init)` takes `method`, `headers`, `body`, `secretHeaders` and `secretQuery`, and
  returns `status`, `ok`, `url`, `headers.get()`, `text()` and `json()`. It reaches hosts on the
  sandbox allowlist plus the poller's extra hosts on public addresses. Parsed JSON takes several
  times its text size, so a script that runs out of memory should keep less.
- `secretHeaders` and `secretQuery` take templates such as `'Bearer {{my_token}}'`. Seti fills in
  the connections the poller may use, by name, and the Default credential's GitHub tokens, sends
  them only to the origin the script named, and shows the script `[secret]` in their place.
- `parseFeed(text)` reads RSS 2.0, RSS 1.0 or Atom into entries with `id`, `title`, `link`,
  `summary`, `published` and `updated`.
- `log(...)` keeps up to 50 lines per run, and `since` is the time of the last good run.

The first good run is a baseline (CHN-17). After it a new key reports the item's kind or `new`, a
changed fingerprint `<kind>.changed` with the fields that changed, and, with Report gone items on,
a key a complete run no longer returns `<kind>.gone`. The fingerprint is the item's own, else a
hash of the fingerprint fields set on the poller, else a hash of the whole item. A key unseen for
30 days, or past the newest 10,000, counts as new if it comes back, and a run with unusable items
reports nothing as gone. Runs are kept 30 days, the latest 50 with their logs. The limits are
`poller_limits` in [Appendix A](protocol.md#appendix-a-reference-constants), plus a jitter under 5
seconds on each interval and 10% on backoff.

The card shows the status (pending, ok, erroring, failing, paused), the last and next run, recent
runs with their logs, Poll to run now, a pause switch, and Edit, whose Test run executes the script
once and shows its items, notes, log and error without storing or reporting anything.

### Schedule

The Schedule tab lists the coming runs of pollers, reminders and the EA's follow-ups for the next
24 hours, 7 days or 30 days, grouped by day in your timezone; a channel with more than 6 runs in a
day shows as one line with the count. Interval runs are projected from the stored next run, so a
poller's real runs differ by its jitter and move back while it backs off. The EA and agents read
the same with `list_channels` and `upcoming`.

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
cd ~/seti && pnpm seti:doctor
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
| Doctor: `memory caps only: the user manager has no cpu controller`      | Add `Delegate=cpu cpuset io memory pids` in a drop-in for `user@.service`                                     |

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

An agent fails to start when the sandbox does not work; it never falls back to running
unsandboxed. An older agent with home folders may keep worktrees in its private home that the host
cannot see, so run `git worktree prune` in a main checkout only when no such agent works on it.

## Why there is no Docker image

Every agent runs in bubblewrap with its own user, PID and network namespaces inside a systemd scope
that caps its memory and CPU. In a container, bubblewrap needs unprivileged user namespaces, which
Docker's default seccomp and AppArmor profiles block, and the caps need a systemd user manager
inside it; making both work takes `--privileged` or its equivalent, which trades the container's
isolation away. The native install is the supported path. PostgreSQL can still run in a container:
pass its URL with `--database-url`.

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
| `pnpm seti:doctor` | Checks this machine and the install                   |

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
| `~/.seti/worktrees/`         | Worktrees of agents made before agents cloned for themselves    |
| `~/.seti/archive/`           | Archived agents' folders, one bundle per archiving              |
| `~/.seti/shared-tools/`      | Published shared tools, one folder per version                  |
| `~/.seti/workspace/<task>/`  | Each agent's workspace of live Markdown files                   |
| `~/.seti/sandbox/`           | Per-task sandbox homes, /tmp and each task's ssh-agent socket   |
| `~/.seti/sandbox-ca/`        | The name-constrained CAs the egress proxy signs with            |
| `~/.seti/backups/`           | Encrypted database backups                                      |
| `~/.seti/pre-credentials-*/` | Env files and units as `migrate-secrets.sh` found them          |
| PostgreSQL database `seti`   | Tasks, transcripts, PRs, channels, the audit log, sealed tokens |
| `~/.claude/projects/`        | Claude Code sessions, which Seti resumes                        |
| `~/work/`                    | One folder per agent, holding its clones and worktrees          |

Settings, Lifecycle lists folders under `~/work` and `~/.seti/worktrees` that no agent owns and
that have not changed for 7 days, and deletes only the ones you pick.

Seti keeps `~/.seti` owner-only and tightens anything more open at startup.
