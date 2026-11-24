# Security

TLDR: anyone who can drive Seti's API can run commands as the Seti user, so the API answers only
its owner, agents run sandboxed with no keys inside, and security settings and secrets stay the
user's. [The SETI Protocol](protocol.md) states those rules; this page is the operator's side:
how to report a flaw, how to harden an install, what runs and listens where, where each secret
lives, and what Seti does not protect. Keep `~/.seti/credentials/secret-key` and the backup private
key off the host.

## Trust model

- The user is the only principal with reserved powers. The EA, agents' Seti tools and mods are
  delegates, and the server refuses them those powers in the function that makes the change
  ([7.1 Actors](protocol.md#71-actors), `server/src/ea-guard.ts`).
- The sandbox, not the permission rules, is the boundary for an agent
  ([7.2 Sandbox](protocol.md#72-sandbox), [7.3 Egress](protocol.md#73-egress)). An unsandboxed
  agent, or one in Bypass, is a per-agent choice of the user's.
- An agent's folder, PR text and every webhook payload are hostile input
  ([7.7 Hostile repositories](protocol.md#77-hostile-repositories)).
- Secret values are write-only and sealed ([8 Secrets](protocol.md#8-secrets-and-connections)).
- Only a short list of paths answers without a credential
  ([18 Public surfaces](protocol.md#18-public-surfaces)).
- Every change is in a hash-chained audit log ([16 Audit](protocol.md#16-audit)).

[Security considerations](protocol.md#21-security-considerations) lists the limits of each of
these. [Implementation](implementation.md#sandbox-mechanism) describes the sandbox mechanism.

## Reporting a vulnerability

Report it privately through GitHub's private vulnerability reporting, never in a public issue.
[SECURITY.md](../SECURITY.md) has the steps, what to include, the response times and the scope.

## Hardening an install

1. Keep Seti on loopback. Reach it over an SSH port forward, a reverse proxy with TLS, or
   Cloudflare Tunnel and Access ([Setup](setup.md#exposing-seti-remotely)), never with
   `SETI_HOST=0.0.0.0` on an open network.
2. On a public hostname, enroll a passkey and turn on Require passkey in Settings, Sign-in. Access
   alone then no longer lets a request in, and installing, granting, updating or uninstalling a
   third-party mod, Developer mode and turning such a mod on also need a passkey check from the
   last five minutes. Set `SETI_ACCESS_EMAILS` to the identities Access may admit.
3. Keep `secret-key` and the backup private key in a password manager, off the host
   ([Key custody](#key-custody)), and turn backups on with `SETI_BACKUP_PUBLIC_KEY`.
4. Encrypt the host volume. Key files are plain owner-only files and the database is not
   encrypted by Seti ([What is not protected](#what-is-not-protected)).
5. Keep agents sandboxed and Bypass off. Run `pnpm run doctor` after an upgrade: it says when the
   sandbox, the AppArmor profile, memory scopes or the CPU controller are missing.
6. Run the live instance from a checkout no agent can write. Agents with home folders write every
   top-level non-dot folder of the home, and that includes a checkout there.
7. Leave Sharing off until you need it, and install only plugins and mods you trust. Developer mode,
   which third-party mod install needs, starts off; `SETI_SAFE_MODE=1` holds every third-party mod
   off.
8. Check the audit chain now and then on the Audit log page against the chain head Seti writes
   to the journal each day.

## What runs and listens where

| Process                          | Runs as                           | Listens                                         |
| -------------------------------- | --------------------------------- | ----------------------------------------------- |
| `seti.service`                   | the Seti user (systemd user unit) | `127.0.0.1:3006`; refuses a `Host` not its own  |
| `seti-ea.service`                | the Seti user                     | `127.0.0.1:3007`; its token only, but `/health` |
| Agents, terminals, `!` commands  | the Seti user, in bubblewrap      | nothing; loopback to their own egress proxy     |
| Converters, reminders, mod logic | the Seti user, in bubblewrap      | nothing                                         |
| Dreams                           | the Seti user, in bubblewrap      | nothing; loopback to a model-only proxy         |
| `seti-redis@<user>` (optional)   | a system unit, `--with-redis`     | a unix socket only the Seti user opens; no TCP  |
| PostgreSQL                       | the system service                | its unix socket, peer authentication            |
| `cloudflared.service` (optional) | the Seti user                     | nothing; outbound to Cloudflare                 |

These paths answer without a token, a session or Access, each with its own check: `/api/ping`;
`/api/local-session` (the local token, on loopback); `/api/auth` sign-in and setup calls (rate
limited); `/api/devices/pair` (a one-time code) and `/api/widget/summary` (a device proof); the
static `/pair` page and `/.well-known/assetlinks.json`; `POST /hooks/<id>`; and `GET` or `HEAD` of
`/share/<token>`, its `/raw`, `/p/1` to `/p/50` and `/card.png`. The app's own page and static
files need no API credential; on a public hostname they sit behind Access when Access is set up.

## Where each secret lives

| Secret                             | Stored as                              | Read by                     |
| ---------------------------------- | -------------------------------------- | --------------------------- |
| Secret store key                   | key file `secret-key`                  | `seti.service`              |
| Local token of the user            | key file `local-token-user`            | `seti.service`, the browser |
| Local token of the EA              | key file `local-token-ea`              | `seti.service`, `seti-ea`   |
| OpenAI key                         | key file `openai-api-key`              | `seti.service`, `seti-ea`   |
| Deepgram, ElevenLabs and TURN keys | key files `deepgram-api-key` and so on | `seti-ea.service`           |
| Tunnel token                       | key file `tunnel-token`                | `cloudflared.service`       |
| GitHub tokens for agents           | sealed rows per credential and owner   | the egress proxy            |
| Claude long-lived token            | sealed row                             | the egress proxy            |
| SSH private keys for agents        | sealed rows                            | each agent's ssh-agent      |
| Webhook signing secrets and tokens | sealed column                          | the webhook receiver        |
| Connection values                  | sealed rows per connection and slot    | pollers, the egress proxy   |
| Secrets an unsandboxed agent asked | 0600 file in the agent's workspace     | that agent                  |
| Push notification key pair         | sealed row, made on first start        | the push sender             |

Key files sit in `~/.seti/credentials` (0600 files in a 0700 directory). Each unit loads only its
own with systemd's `LoadCredential=`, so none reaches an environment variable or a command line,
and agent sandboxes see neither that directory nor `/run/user`. Without systemd
(`scripts/start.sh`) the server reads the same directory itself, or `SETI_CREDENTIALS_DIR`, and
hides it from sandboxes the same way. Development and test runs use `SETI_HOME/dev-credentials` and
create what is missing; production never creates a key file and stops naming the missing one.
`scripts/install.sh` creates them owner-only and never prints one. Sealed values use AES-256-GCM
bound to their name, never leave the server, and are set and cleared in Settings, Credentials and
Settings, Connections. The host's `gh` login, which the PR views use, is neither stored nor read
by Seti. Seti keeps `~/.seti` owner-only and tightens anything more open at startup.

## What is not protected

- systemd 255's user manager cannot decrypt credentials, so the key files are plain files the Seti
  user can read, and Seti does not encrypt the database. An unsandboxed agent runs as that user and
  can read them. Full-disk encryption is the control for data at rest.
- Without bubblewrap, reminders run with only their Node lockdown between them and the network,
  which Seti logs once, and third-party mod logic has only Node's permission model, which Doctor
  and the consent screen say.
- A mod's view may leak what the mod hands it through WebRTC paths, DNS prefetch or a browser
  request no policy names, and a host granted to a mod is two-way. The consent screen says both.
- With Scripts on, an agent's HTML preview can still reach a STUN or TURN server the page names
  through WebRTC, which no page policy blocks yet. Scripts start off for each file.
- A share link's preview card that a chat app already fetched stays in that app's cache after the
  share is revoked or expires. Share views are counted with Cloudflare's country header and a
  clipped user agent.
- A shell opened outside an agent, or for an unsandboxed agent, is the Seti user's own login shell
  with its profile and rc files. A program in any terminal may write the clipboard with OSC 52;
  Seti never answers a clipboard read.
- Claude Code plugins run their author's code as the Seti user in the terminal and in every agent
  that loads them.
- Review rules for one tool trust the server's own annotations to list its other writing tools; a
  rule for the whole server does not depend on them.
- Seti writes to a GitHub PR in one case: the preview label, while the PR previews mod is on.

The public demo runs with a separate entry point and threat model; see [Public demo](demo.md).

## Key custody

Keep two files off the host, in a password manager:

- `~/.seti/credentials/secret-key`. Backups do not contain it, and a restored database needs it to
  open stored tokens and webhook secrets. Without it, set the tokens and rotate the webhooks again.
- The backup private key from `backup keygen`. The host holds only the public key, so it cannot
  read its own backups.

## Rotating

- A local token: write a new value to its file
  (`head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n'`), then restart `seti.service`,
  and `seti-ea.service` for the EA's token. Browsers sign in again.
- A provider key or the tunnel token: replace its file and restart the unit that loads it.
- A Claude token: set it again in Settings, Credentials. A GitHub token: set it again in its
  credential in Settings, Credentials. A connection's value: set it again in Settings, Connections.
- A webhook secret: Rotate in Settings, Channels; the old secret stops working at once.
- The secret store key: replace the file, then set every token and rotate every webhook again.
  Seti does not re-seal old values. It makes a new push key pair, so turn Push on again on each
  device in Settings, Notifications.

## Rolling back past the secret store

Versions before the key files kept keys in `~/.seti/*.env` and webhook secrets in the clear.
`migrate-secrets.sh` backed the originals up to `~/.seti/pre-credentials-<time>/`. To go back:
stop `seti.service`, unseal the webhook secrets, restore the files, then deploy the older commit.

```sh
systemctl --user stop seti.service
systemd-run --user --wait --pipe -p WorkingDirectory="$HOME/seti-live" \
  -p LoadCredential=secret-key:"$HOME/.seti/credentials/secret-key" \
  -p EnvironmentFile="$HOME/.seti/seti.env" \
  /usr/bin/zsh -ic 'source ~/.nvm/nvm.sh && nvm use 24 >/dev/null && pnpm --filter @seti/server secrets unseal-channels'
deploy/migrate-secrets.sh --rollback ~/.seti/pre-credentials-<time>
```
