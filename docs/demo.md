# Public demo

TLDR: `pnpm demo` runs a demo of Seti on this machine, and `deploy/demo/` builds it as a sealed
container for the internet. Visitors press Enter demo and look around a made-up team's Seti:
scripted agents, a permission prompt, pull requests on a fake GitHub and a fake EA. Nothing runs:
the server refuses every route that is not on the demo's allowlist, the process cannot start a
program, open a terminal or reach the network, and the container has no host mounts, a read-only
root and no way out. Everything resets every three hours and on every restart.

## What visitors see

The demo seeds the fictional Acme team the README screenshots show: five agents on four repos,
one of them waiting on a `terraform apply` permission, a group chat, two webhook channels and the
EA's chat. A visitor can:

- answer the permission prompt with Allow or Deny;
- message an agent, which plays a short scripted turn: asking it to open a PR opens one on the fake
  GitHub and links it, asking it to deploy or apply raises a permission prompt;
- start a new agent from the start page, without a worktree;
- chat with the EA, which answers with a fixed note;
- browse PRs, the audit log and the files of the demo repos;
- read the settings pages, whose changes the demo refuses;
- pair the Android app and see its widget fill with the demo's agents.

A line under the header marks every page as the demo and says when it resets. Visitors share one
demo, so what one visitor types, another sees until the next reset.

## Run it locally

`pnpm demo` builds the UI and the demo bundle, then serves the demo at http://localhost:3016. It
needs the PostgreSQL role development uses (see [CONTRIBUTING](../CONTRIBUTING.md)), and it drops
and recreates the database `seti_demo` on every start; the demo refuses to run on a database whose
name does not start with `seti_demo`. Each start takes a fresh data folder under `$TMPDIR`.

| Variable                 | Default                                            | What it sets                |
| ------------------------ | -------------------------------------------------- | --------------------------- |
| `SETI_DEMO_PORT`         | `3016`                                             | The local port              |
| `SETI_DEMO_DATABASE_URL` | `postgresql:///seti_demo?host=/var/run/postgresql` | The database the demo drops |
| `SETI_DEMO_RESET_HOURS`  | `3`                                                | Hours between resets        |

`pnpm demo` is for trying the demo out. Put only the container on the internet.

## Run the container

The image holds PostgreSQL and the demo bundle; its entrypoint starts a private PostgreSQL on a
tmpfs, listening on a unix socket only, then the demo in its place. Build it from the repo root:

```sh
docker build -f deploy/demo/Dockerfile -t seti-demo .
```

`deploy/demo/compose.yaml` runs it the way it is meant to face the internet: the demo on an internal
network with no route out, and a Caddy reverse proxy as the only container that publishes a port.

```sh
cd deploy/demo
docker compose up -d --build                  # http://127.0.0.1:8080
SETI_DEMO_BIND=0.0.0.0:8080 SETI_PUBLIC_URL=https://demo.example.com docker compose up -d
```

Both containers run as non-root users with every capability dropped (the proxy keeps
`NET_BIND_SERVICE`), `no-new-privileges`, a read-only root, tmpfs for everything they write, and
memory, CPU and process limits. The demo's data, its database included, lives on the tmpfs, so a
restart starts from nothing. Every `SETI_DEMO_RESET_HOURS` the demo exits, and the restart policy
starts a fresh one; a visitor's session ends with it.

To run the image without compose, keep the same limits. Plain `docker run` leaves the default
network's route out open, so the process seal is then the only egress control; block egress on the
host or use the compose file.

```sh
docker run -d --name seti-demo --init --read-only --user 10001:10001 --cap-drop ALL \
  --security-opt no-new-privileges:true --memory 1g --cpus 1 --pids-limit 256 \
  --tmpfs /data:size=768m,mode=0700,uid=10001,gid=10001 \
  --tmpfs /tmp:size=64m,mode=0700,uid=10001,gid=10001 \
  --restart unless-stopped -p 127.0.0.1:8080:3016 seti-demo
```

| Variable                | Default          | What it sets                                                   |
| ----------------------- | ---------------- | -------------------------------------------------------------- |
| `SETI_PUBLIC_URL`       | unset            | The https origin visitors use; unset, only loopback names work |
| `SETI_DEMO_RESET_HOURS` | `3`              | Hours between resets                                           |
| `SETI_DEMO_BIND`        | `127.0.0.1:8080` | Where the compose proxy listens                                |

On a public hostname, terminate TLS in front of the proxy (a tunnel, a load balancer or Caddy with
its own certificate), pass the original `Host` through, and set `SETI_PUBLIC_URL` to that https
origin. Sessions then use a `__Host-` secure cookie, writes must carry that origin, and the
sign-in rate limit counts clients by `CF-Connecting-IP`, else the first `X-Forwarded-For` address,
which the proxy in front must set itself rather than pass on from the client.

## App store review

Store reviewers can pair the Android app with a demo on a public https hostname:

1. Open the demo, press Enter demo, then go to Settings, Sign-in and choose Pair phone.
2. Scan the QR code with the app, or open its link on the phone.
3. The app pairs with the `widget` scope, the only one, and the home screen widget shows the demo's
   agents that need the user.

A paired device reaches only the widget summary, as on any Seti. Devices pair into the demo's
database and are gone at the next reset.

## Security model

Anyone may hold the demo's address, so the demo assumes visitors try to escape and makes that
impossible in four layers, each enough on its own for what it covers.

1. **Route allowlist.** `server/src/demo/guard.ts` runs before Seti's own middleware. A request
   passes only when every route it matches, middleware included, is listed in
   `server/src/demo/allowlist.ts`; anything else gets 403 Not in the demo. A route added to Seti
   later is refused until someone lists it. Writes that are listed take only the fields the
   allowlist names, so no request can point an agent at a path, turn on access or attach a file.
2. **Sealed process.** `server/src/demo/seal.ts` runs before any server module loads. It replaces
   every way to start a process (`spawn`, `exec`, `execFile`, `fork`, the sync forms and
   `ChildProcess#spawn`), terminals (`node-pty`), worker threads and UDP sockets, and lets TCP
   connect only to loopback and unix sockets. The one program the demo answers is a read-only
   `gh api`, answered in-process by the fake GitHub. The demo runs as a prebuilt bundle, so no
   transpiler starts after the seal.
3. **Fakes instead of services.** Agents are a scripted stand-in for Claude Code that only writes
   transcript messages; its permission prompts go through Seti's real permission flow and run
   nothing when allowed. The planner, GitHub, the EA and Claude Code's capability probe are fakes
   in the same process. The sandbox setting is off because no agent process exists to sandbox.
4. **Container.** No host mounts, a read-only root, a non-root user, no capabilities,
   `no-new-privileges`, tmpfs data, memory, CPU and process caps, and an internal network with no
   route out.

What the demo refuses, by area:

| Area                   | Refused                                                                         |
| ---------------------- | ------------------------------------------------------------------------------- |
| Processes              | Terminals, `!` shell runs, background shells, process stop, every program       |
| Agents                 | Creating with a path or worktree, extra dirs and repos, sandbox and access      |
| Files                  | Saving, uploads, attachments, file search, shares and share links               |
| Credentials and access | Connections, credentials, SSH hosts and keys, AWS, sandbox settings             |
| Claude Code            | Plugins, marketplaces, MCP servers and sign-ins, account logins, session import |
| Automation             | Webhook deliveries, pollers, reminders, archive and retention                   |
| Sign-in                | Passkeys, setup codes, the local token sign-in, the session list, enforcement   |
| Network                | Push subscriptions, the weather, PR previews, every connection off the host     |
| Changes to Seti        | The changelog's update, user settings, EA settings, permission rules            |

What the demo does not protect: visitors share one demo, so text one visitor writes (messages,
agent titles, device names, chat) is visible to the others until the next reset. The reset bounds
how long anything lasts, the sign-in is rate limited per client and the demo stops issuing
sessions at 2,000 live ones.

## Changing the demo

The cast lives in `server/src/demo/content/`, shared with the README screenshots, and the scripted
turns in `server/src/demo/turns.ts`. To let the demo answer a route, add it to
`server/src/demo/allowlist.ts` with the reason it is safe: it reads only the demo database, the
demo's data folder or the fakes, or its write changes only the demo database. `pnpm check` runs
`server/src/demo/guard.test.ts`, which requests every route of the app that the allowlist leaves
out and expects the refusal, and fails when middleware on an allowed path changes. The `demo` e2e
specs run the bundle as a visitor would.
