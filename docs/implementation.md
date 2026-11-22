# How Seti implements the protocol

TLDR: [The SETI Protocol](protocol.md) says what Seti does; this page says how this codebase does
it. One Node server owns every agent session and all state in PostgreSQL. The EA is a separate
Python process. Agents run in bubblewrap inside a systemd scope, behind a per-agent egress proxy.
Pollers, reminders, third-party mod logic and file converters each run in an engine or sandbox of
their own. Seti uses the reference values in the protocol's Appendix A.

## Processes

```
 browser --HTTP, SSE--> seti server (Node, 127.0.0.1:3006)
                          |-- routes, store (PostgreSQL), audit chain
                          |-- runner: one Claude Code process per open agent, each under bwrap
                          |   in a systemd scope, with an egress proxy reached by a unix socket
                          |-- poller and webhook filter worker threads (QuickJS in WebAssembly)
                          |-- schedulers: PR poller, reminders, backups, retention, EA inbox
                          |-- children: reminder runs, mod logic runner, file converters
                          '-- Redis: shared caches and event relay
 EA (Python, 127.0.0.1:3007) <--/api/ea proxy-- seti server
```

| Process               | What it is                                                                 | Protocol      |
| --------------------- | -------------------------------------------------------------------------- | ------------- |
| `seti.service`        | The Hono server in `server/`; holds the open sessions in `session-host.ts` | ENT-13        |
| Agent sessions        | Claude Code via `runtimes/claude/` and the Agent SDK, about 300 MB each    | 3.2, 7.2, 7.8 |
| `seti-ea.service`     | The EA in `ea/`, a pipecat process with its own token                      | 14            |
| Poller workers        | Worker threads in the server (`SETI_POLLER_WORKERS`, 2 by default)         | CHN-12        |
| Filter workers        | Two worker threads in the server, a fresh QuickJS engine per delivery      | CHN-32        |
| Reminder runs         | A fresh `node --permission` child per run, inside `bwrap --unshare-all`    | CHN-20        |
| Mod logic runner      | Long-lived children (`SETI_MOD_WORKERS`), a fresh QuickJS engine per event | MOD-12        |
| Converters            | poppler, LibreOffice, ffmpeg, ffprobe and resvg for share pages, sandboxed | PUB-7         |
| `cloudflared.service` | Optional tunnel                                                            | none          |
| `seti-redis@<user>`   | Optional Redis on a unix socket                                            | none          |

A stop (SIGTERM or SIGINT) runs `cutRunningTurns` in `server/src/restart-cut.ts`, which writes one
`restart_cut` row per running turn and interrupts it, within `stop_grace` and well inside
systemd's default stop timeout. Startup reads those rows in `server/src/restart-resume.ts`
(RES-1 to RES-8). A crash leaves no rows, so every agent still `running` is treated as a `user`
turn.

One process owning every session caps a host at a few dozen open agents. The path past that is
runner workers that claim agents from PostgreSQL (`FOR UPDATE SKIP LOCKED` with a lease), with the
PR poller and reminder ticker on one elected process; the storage split below already allows it.

## Code map

[CONTRIBUTING](../CONTRIBUTING.md#code-map) lists the top-level folders. This table maps each
protocol section to the files that implement it. Paths are under `server/src/` unless they start
with another top-level folder.

| Section        | Main files                                                                                                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 3 Entities     | `shared/src/tasks.ts`, `shared/src/inputs.ts`, `shared/src/requests.ts`, `shared/src/events.ts`, `shared/src/runtimes/`, `events/`, `db.ts`, `pending-requests.ts`                               |
| 4 Turns        | `runner.ts`, `session-host.ts`, `session-ingest.ts`, `session-spec.ts`, `runtime-host.ts`, `runtimes/`, `agent-session.ts`, `rewind.ts`, `turn-asking.ts`, `closing-line.ts`, `task-location.ts` |
| 4 Restarts     | `session-restart.ts`, `input-queue.ts`                                                                                                                                                           |
| 4 Node link    | `node-link.ts`, `node-commands.ts`, `session-control.ts`, `session-mirror.ts`, `session-setup.ts`, `session-tools.ts`, `turn-asks.ts`, `shared/src/node-protocol.ts`                             |
| 5 Updates      | `shared/src/channel-delivery.ts`, `inputs.ts`, `input-preface.ts`                                                                                                                                |
| 6 Attention    | `shared/src/attention.ts`, `task-blocked.ts`, `stall-watch.ts`, `ea-attention.ts`, `notifications.ts`, `notify-scope.ts`, `presence.ts`, `attention-brief.ts`                                    |
| 7.1 Actors     | `access.ts`, `ea-guard.ts`                                                                                                                                                                       |
| 7.2, 7.3       | `sandbox.ts`, `sandbox-mounts.ts`, `egress-proxy.ts`, `egress-rules.ts`, `egress-placeholders.ts`, `sandbox-ca.ts`, `ssh-agent.ts`, `agent-access.ts`                                            |
| 7.4, 7.5       | `permission-policy.ts`, `policy/`, `permission-requests.ts`, `permission-timeout.ts`, `permission-guard.ts`, `repeat-hooks.ts`, `review-hooks.ts`, `outward.ts`                                  |
| 7.6 Changes    | `change-requests.ts`, `change-request-notes.ts`, `mcp-off-context.ts`, `shared/src/change-requests.ts`                                                                                           |
| 7.7 Hostile    | `git.ts`, `probe-launch.ts`, `task-files.ts`, `html-preview.ts`, `uploads.ts`                                                                                                                    |
| 7.8 Caps       | `launcher.ts`, `memory-scope.ts`, `scope-cpu.ts`, `oom-guard.ts`                                                                                                                                 |
| 8 Secrets      | `secret-box.ts`, `connections.ts`, `scrub.ts`, `secret-questions.ts`, `secret-delivery.ts`                                                                                                       |
| 9 Shared tools | `shared/src/shared-tools.ts`, `shared-tool-proposals.ts`, `shared-tool-files.ts`, `shared-tool-server.ts`                                                                                        |
| 10 Events      | `shared/src/webhook-senders.ts`, `shared/src/webhook-sender-catalog.ts`, `channels/`, `pollers/`, `reminders/`, `quickjs/`                                                                       |
| 11 PRs         | `pr-inputs.ts`, `pr-self.ts`, `pr-link.ts`, `github-list.ts`, `pr-details.ts`, `shared/src/pr-fix-ci.ts`                                                                                         |
| 12 Chat        | `team.ts`, `team-active.ts`, `direct-privacy.ts`, `side-chat/`, `mods/side-chat/`                                                                                                                |
| 13 Tools       | `seti-tools/`, `questions.ts`, `question-answers.ts`, `house-rules.ts`, `knowledge.ts`, `knowledge-review.ts`                                                                                    |
| 14 Assistant   | `ea/src/seti_ea/` (`gate.py`, `asks.py`, `inbox.py`, `settle.py`, `held.py`, `promises.py`), `ea-deliver.ts`, `routes/ea-replies.ts`                                                             |
| 15 Resilience  | `restart-cut.ts`, `restart-resume.ts`, `restart-waits.ts`, `permission-grants.ts`, `client-sends.ts`, `model-fallback.ts`, `archive-files.ts`, `owned-dirs.ts`                                   |
| 15 Storage     | `storage-overview.ts`, `storage-clean.ts`, `storage-orphans.ts`, `storage-schedule.ts`, `rebuildable.ts`, `dir-size.ts`, `size-cache.ts`                                                         |
| 16 Audit       | `audit.ts`, `store/audit.ts`                                                                                                                                                                     |
| 17 Mods        | `mods/`, `shared/src/mods.ts`, `packages/mod-api/`; [Mods](mods.md) is the authoring guide                                                                                                       |
| 18 Public      | `access.ts`, `routes/share-public.ts`, `share-preview/`, `converter.ts`, `rate-limit.ts`, `security-headers.ts`                                                                                  |
| 19 Client      | `http.ts`, `etag.ts`, `devices.ts`, `shared/src/lenient.ts`, `ui/src/lib/poll-loop.ts`, `ui/src/lib/stale-build.ts`                                                                              |

## Storage

- PostgreSQL 16 is the only store, reached on its unix socket with peer authentication, so no
  database password exists. Migrations (`MIGRATIONS` in `server/src/store/schema.ts`) run at
  startup in one transaction under an advisory lock, and the audit chain appends under a row lock
  on its head, so several processes can share one database.
- A transcript row keeps the message as its runtime wrote it. Ingest also fills columns from the
  row's neutral events (`server/src/events/columns.ts`): `runtime`, `thread`, the leading `event`
  type, `agent` (it holds the agent's own output) and, on a turn's end, `turn_usd`, `turn_ms`,
  `turn_steps` and `turn_reply`. Queries filter on these columns, not on the runtime's JSON. A row
  without `runtime` is not filled yet; startup fills such rows in the background, newest first
  (`server/src/store/event-columns.ts`). Until then the filters in `server/src/store/event-filters.ts`
  read such a row by its JSON, so every view shows it as before.
- Redis holds only what can be rebuilt: GitHub PR lists and the GraphQL budget, capability and
  account probes, the EA's live context, and pub/sub for agent events and group chat across
  processes. It keeps nothing on disk and never holds a token. `SETI_REDIS_URL=off` costs cache
  misses, not errors.
- Service secrets are key files in `~/.seti/credentials`, which systemd hands each unit with
  `LoadCredential=`. Values set in the UI are sealed into PostgreSQL by `server/src/secret-box.ts`
  under the `secret-key` file (SEC-5). [Security](security.md#where-each-secret-lives) lists each.
- Archiving packs an agent's folder and workspace into
  `~/.seti/archive/<task id>/files-<stamp>.tar.zst`, leaving out the rebuildable folders Storage
  names (`REBUILDABLE_DIRS` and `REBUILDABLE_IF_IGNORED` in `shared/src/storage.ts`), and reads
  the bundle back in full before it removes an original. Its transcript moves into a compressed
  `task_archive` row.
- A published shared tool is written to `shared-tools/<name>-<hash>` under Seti's home (`tool.json`
  and the script); startup rewrites missing folders from the `shared_tool` table and removes the
  rest. Each session gets one stdio MCP server, `shared`, which is `server/src/shared-tool-server.ts`.

[Setup](setup.md#where-data-lives) lists every path on disk.

## Folder sizes, Clean and orphans

- **Sizes.** `GET /api/storage` (`server/src/storage-overview.ts`) answers at once from what is
  measured so far, with `measuring` while background work is pending. An agent's folders
  (`server/src/storage-folders.ts`) are its scratch folder, worktrees, workspace and sandbox
  folder, which Seti made, and checkouts it was given, which it did not. `server/src/dir-size.ts`
  walks a folder without following symlinks, counts each hard-linked file once, stops at
  `SIZE_CAPS` and marks such a size `capped`; one walk also sizes every folder directly inside.
  `server/src/size-cache.ts` runs walks and plans one at a time in a background queue, keeps sizes
  for 10 minutes and serves the old value while a new one is measured (RES-19).
- **Tree.** `GET /api/tasks/:id/files/tree` (`server/src/task-files-tree.ts`) lists one folder
  through the same checks as `files/list`, with each folder's cached size, a rebuildable mark and
  a git badge from `git status --porcelain=v2 --branch` (`server/src/git-state.ts`, cached for 30
  seconds, 3-second limit) through `agentGit`. A sandboxed agent's private home and `/tmp` are
  read-only roots; the home's logins and Claude data (`sandboxHomeHidden`) are hidden (HST-9).
- **Clean.** `server/src/rebuildable.ts` finds candidates up to six levels down without entering a
  `.git` folder, a symlink or a candidate, then asks each candidate's repository with one
  `git ls-files` and one `git check-ignore` per batch. `server/src/storage-clean.ts` refuses with
  409 while the agent runs, re-plans on confirm, removes only what both the plan and the request
  name, and records one `task.storage_cleaned` event (RES-16).
- **Removal.** Every removal goes through `server/src/owned-dirs.ts`. A linked worktree goes
  through its main checkout's `git worktree remove`; anything else is `fs.rm` on the checked path.
  `removeNestedDir` removes one rebuildable folder inside an agent folder that passes the same
  checks, and only when its real path is the agent folder's real path joined with the target's
  relative path, so no symlink on the way leads elsewhere.
- **Orphans.** `server/src/storage-orphans.ts` lists folders in the scratch, worktree, workspace,
  sandbox and archive roots that no agent owns, is named for or works in, plus `task_worktree`
  records of agents not archived whose folder is gone. It runs the git check for uncommitted or
  unpushed work in the background and again before a removal, which records
  `system.orphans_removed` (RES-17).
- **Automatic clean.** `server/src/storage-schedule.ts` keeps its settings in `storage_settings`;
  an hourly sweep cleans agents idle past the chosen days and archived agents, skips running ones
  and stores the time and bytes of its last run (RES-18). `refuseDelegates` guards orphan removal
  and the schedule; the EA reads the page and trees through `resource_usage` and cleans one agent
  through `run_archive_sweep`'s `clean_agent`, and `cleanAgent` refuses agents.

## Sandbox mechanism

Each agent's Claude Code process, each `!` command, its terminal and the rewind helper run under
bubblewrap with their own PID, network, IPC and UTS namespaces. `server/src/sandbox-mounts.ts`
builds the mount list of SBX-2: a private home under `~/.seti/sandbox`, the agent's folder under
`SETI_SCRATCH_ROOT`, its workspace and package caches read-write; the system, toolchains, Claude
Code configuration and approved shared tool folders read-only. The directory the server runs from
is never mounted, except the shared tool server's own file, read-only. Ubuntu 23.10 and later need
the AppArmor profile for `bwrap` that the installer adds ([Setup](setup.md#sandbox)).

- **Network.** The namespace has only loopback. `socat` bridges `127.0.0.1:3128` to the agent's
  egress proxy in the server, over a unix socket. The proxy terminates TLS for Anthropic, GitHub,
  signed-in tool-server hosts and the agent's connection hosts with CAs in `~/.seti/sandbox-ca`,
  name-constrained to those hosts (EGR-4). SSH goes through a per-agent `ssh-agent` that holds
  only the keys of the agent's usable logins.
- **Permissions.** Claude Code runs in its `auto` permission mode with Seti's rules, and its
  auto-mode classifier is the classifier of PERM-2. In auto mode Claude Code drops broad shell
  allow rules, so the classifier also reviews a sandboxed agent's shell commands. Where auto mode
  is unavailable Claude Code starts in `default` mode and every call no rule allows becomes a
  request. Bypass is Claude Code's `bypassPermissions` mode. The repeat guard and review rules are
  `PreToolUse` hooks, so they hold in Bypass.
- **Memory and CPU.** Each agent's process tree starts through `systemd-run --user --scope` with
  `MemoryMax`, 1 GB of `MemorySwapMax`, `OOMPolicy=continue`, `CPUWeight=50`, `CPUQuota` and
  `BindsTo=` the server's unit, so agents end with Seti (CAP-5). Every 100 ms Seti raises the
  `oom_score_adj` of tools in the scope to 800, so the kernel stops the largest tool before Claude
  Code (CAP-2). `memory.events` and, where readable, `journalctl -k` name what was stopped.
  `MemoryHigh` is `infinity` unless set as an advanced setting. The agent learns its cap through
  its prompt and `SETI_MEMORY_CAP_MB`, and Node tools default to a heap of 70% of it. The CPU
  quota needs the cpu controller delegated to the user manager; without it scopes carry the memory
  cap alone, and without a user manager (or with `SETI_MEMORY_SCOPES=off`) agents run unscoped.
- **Script engines.** Pollers run in QuickJS compiled to WebAssembly, a fresh engine per run on a
  worker thread; memory is capped by the WebAssembly maximum, a worker has a 128 MB heap and is
  terminated 2 seconds past its run's timeout, and the worker replaces every secret value in what
  it returns. Webhook filters use the same engine and worker pool code
  (`server/src/quickjs/pool.ts`) on workers of their own with no host functions but `log`, warmed
  at startup when any filter is on, so a delivery starts no process. Reminders run in a child Node with `--permission`, an empty environment and a module
  hook that admits only pure builtins, inside `bwrap --unshare-all`; `server/src/script-sandbox.ts`
  builds that command for reminders and mod logic alike.
- **Converters.** `server/src/converter.ts` runs each converter in bwrap with every namespace
  unshared and no capabilities, `/usr` and font configuration read-only, a read-only copy of the
  input, prlimit caps (512 MB to 1.5 GB of memory, CPU time, file size, open files), a wall-clock
  timeout on the process group, capped output, and at most two at once at low priority.
  LibreOffice starts from a fresh profile with macros disabled and Java off.
- **Agent-writable folders.** Seti runs git there only through `agentGit` in `server/src/git.ts`
  (HST-2), probes capabilities through `server/src/probe-launch.ts` (HST-4), and serves HTML
  previews under the policy in `server/src/html-preview.ts` (HST-5).

## The EA

The EA is a pipecat process: OpenAI models for chat and voice, Deepgram for speech to text and
ElevenLabs for text to speech. Its tools live in `ea/src/seti_ea/*_tools.py`, `tools.py` and
`actions.py`, and every write passes `gate.py`, which records the ask in Seti's `ea_ask` table
(EA-3, EA-4). Its `think` tool hands a hard question to a reasoning model (`EA_THINK_MODEL`) with
only the read tools in `THINK_TOOLS` and `store=False` at OpenAI; the conversation goes on while it
works. `promises.py` implements EA-12 without a model call. `settle.py` and `held.py` implement
EA-10. The EA posts usage records (numbers and model names, never text) to `ea_usage`, kept 30
days. The language setting reaches Deepgram, ElevenLabs and the prompt; the wake word model knows
English sounds only.

## Reference values

Seti uses every value in [Appendix A](protocol.md#appendix-a-reference-constants) of the
protocol. An install can change these:

| Constant or rule             | Where                                       |
| ---------------------------- | ------------------------------------------- |
| `idle_close`                 | `SETI_SESSION_IDLE_MINUTES`                 |
| `mem_cap`, `cpu_cap`         | Settings, Resources, and per agent          |
| `audit_keep`                 | `SETI_AUDIT_RETENTION_DAYS`                 |
| `session_life`               | `SETI_AUTH_IDLE_DAYS`, `SETI_AUTH_MAX_DAYS` |
| Request timeout (PERM-7)     | Settings, Permissions                       |
| Tier surfaces (ATT-8)        | Settings, Notifications                     |
| Resume after restart (RES-4) | Settings, Lifecycle                         |
| Repeat guard (GRD-4)         | Settings, Lifecycle                         |
| Mod update delay (MOD-15)    | Settings, Mods                              |
| Poller and mod worker counts | `SETI_POLLER_WORKERS`, `SETI_MOD_WORKERS`   |

Every other value is a constant in `shared/src/` or `server/src/`, next to the code that uses it.

## Beyond the protocol

Seti also has features the protocol leaves to implementations: interactive terminals
(`server/src/terminal.ts`), the Files view and share link previews (`server/src/share-preview/`),
Claude Code plugins and MCP server settings, Home's graph and shipping counts
(`server/src/home.ts`), the Schedule tab (`shared/src/schedule.ts`), What's new
(`mods/whats-new/`), backups (`server/src/backup.ts`) and the public demo ([Demo](demo.md)).
[Security](security.md) covers the facts about them an operator needs.
