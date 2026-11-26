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
| `seti-node.service`   | `server/src/node/main.ts` with `SETI_NODE=split`; holds the open sessions  | NODE-1        |
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

With `SETI_NODE=split` the sessions run in a separate node process instead, behind
`SETI_HOME/run/node.sock`. The server connects to it as a client (`node-client.ts`, wired in
`node-split.ts`), applies its journal from cursors kept in `node_cursor`, answers its asks and sends
it commands. A stop of the server cuts no turns; a stop of the node has the server record them
first. `server/src/node/imports.test.ts` lists each module of the node that still loads the store.

One process owning every session caps a host at a few dozen open agents. The path past that is
runner workers that claim agents from PostgreSQL (`FOR UPDATE SKIP LOCKED` with a lease), with the
PR poller and reminder ticker on one elected process; the storage split below already allows it.

## Code map

[CONTRIBUTING](../CONTRIBUTING.md#code-map) lists the top-level folders. This table maps each
protocol section to the files that implement it. Paths are under `server/src/` unless they start
with another top-level folder.

| Section        | Main files                                                                                                                                                                                                                                                                                                                                                        |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3 Entities     | `shared/src/tasks.ts`, `shared/src/inputs.ts`, `shared/src/requests.ts`, `shared/src/events.ts`, `shared/src/runtimes/`, `events/`, `db.ts`, `pending-requests.ts`, `codex-status.ts`, `codex-install.ts`, `codex-fetch.ts`, `codex-pin.ts`                                                                                                                       |
| 3.7 Ledger     | `sources/` (one adapter per source, `refs.ts` for cited URLs, `quote.ts`, `match.ts`), `store/sources.ts`, `routes/sources.ts`, `shared/src/sources.ts`                                                                                                                                                                                                           |
| 4 Turns        | `runner.ts`, `session-host.ts`, `session-ingest.ts`, `codex-spend.ts`, `codex-host.ts`, `codex-decide.ts`, `session-spec.ts`, `session-realise.ts`, `runtime-host.ts`, `runtimes/`, `agent-session.ts`, `rewind.ts`, `turn-asking.ts`, `closing-line.ts`, `task-location.ts`                                                                                      |
| 4 Restarts     | `session-restart.ts`, `input-queue.ts`                                                                                                                                                                                                                                                                                                                            |
| 4 Node link    | `node-link.ts`, `node-commands.ts`, `session-control.ts`, `session-mirror.ts`, `session-setup.ts`, `session-tools.ts`, `turn-asks.ts`, `shared/src/node-protocol.ts`                                                                                                                                                                                              |
| 15.1 Node      | `node/`, `node-client.ts`, `node-split.ts`, `node-inbox.ts`, `node-outbox.ts`, `node-pid.ts`, `tool-calls-restore.ts`, `prompt-open.ts`, `store/node-*.ts`, `shared/src/node-frames.ts`                                                                                                                                                                           |
| 5 Updates      | `shared/src/channel-delivery.ts`, `inputs.ts`, `input-preface.ts`                                                                                                                                                                                                                                                                                                 |
| 6 Attention    | `shared/src/attention.ts`, `task-blocked.ts`, `stall-watch.ts`, `ea-attention.ts`, `notifications.ts`, `notify-scope.ts`, `presence.ts`, `attention-brief.ts`                                                                                                                                                                                                     |
| 7.1 Actors     | `access.ts`, `ea-guard.ts`                                                                                                                                                                                                                                                                                                                                        |
| 7.2, 7.3       | `sandbox.ts`, `sandbox-mounts.ts`, `sandbox-bwrap.ts`, `sandbox-codex.ts`, `sandbox-read-only.ts`, `egress-*.ts`, `sandbox-ca.ts`, `sandbox-aws-token.ts`, `task-proxy.ts`, `launch-plan.ts`, `proxy-grant.ts`, `codex-key.ts`, `egress-connections.ts`, `proxy-owner.ts`, `secret-asks.ts`, `ask-in-time.ts`, `ssh-agent.ts`, `agent-access.ts`, `tool-relay.ts` |
| 7.4, 7.5       | `permission-policy.ts`, `policy/`, `permission-requests.ts`, `permission-timeout.ts`, `permission-guard.ts`, `repeat-hooks.ts`, `review-hooks.ts`, `shadow-hooks.ts`, `outward.ts`, `outward-push.ts` and `push-asks.ts` (PERM-15: `policy/outward.ts` reads the command, the Claude agent's `Bash` hook in `runtime-host.ts` and `codex-decide.ts` ask)          |
| 7.6 Changes    | `change-requests.ts`, `change-request-notes.ts`, `mcp-off-context.ts`, `shared/src/change-requests.ts`                                                                                                                                                                                                                                                            |
| 7.7 Hostile    | `git.ts`, `runtimes/claude/probe-launch.ts`, `task-files.ts`, `html-preview.ts`, `uploads.ts`                                                                                                                                                                                                                                                                     |
| 7.8 Caps       | `launcher.ts`, `memory-scope.ts`, `scope-cpu.ts`, `scope-limits.ts`, `scope-control.ts`, `oom-guard.ts`                                                                                                                                                                                                                                                           |
| 8 Secrets      | `secret-box.ts`, `connections.ts`, `scrub.ts`, `secret-questions.ts`, `secret-delivery.ts`                                                                                                                                                                                                                                                                        |
| 9 Shared tools | `shared/src/shared-tools.ts`, `shared-tool-proposals.ts`, `shared-tool-files.ts`, `shared-tool-server.ts`                                                                                                                                                                                                                                                         |
| 10 Events      | `shared/src/webhook-senders.ts`, `shared/src/webhook-sender-catalog.ts`, `channels/`, `pollers/`, `reminders/`, `quickjs/`                                                                                                                                                                                                                                        |
| 11 PRs         | `pr-inputs.ts`, `pr-self.ts`, `pr-link.ts`, `github-list.ts`, `pr-details.ts`, `shared/src/pr-fix-ci.ts`                                                                                                                                                                                                                                                          |
| 12 Chat        | `team.ts`, `team-active.ts`, `direct-privacy.ts`, `direct-codex.ts`, `side-chat/`, `mods/side-chat/`                                                                                                                                                                                                                                                              |
| 13 Tools       | `seti-tools/`, `questions.ts`, `question-answers.ts`, `house-rules.ts`, `knowledge.ts`, `knowledge-review.ts`                                                                                                                                                                                                                                                     |
| 14 Assistant   | `ea/src/seti_ea/` (`gate.py`, `asks.py`, `inbox.py`, `settle.py`, `held.py`, `promises.py`), `ea-deliver.ts`, `routes/ea-replies.ts`                                                                                                                                                                                                                              |
| 15 Resilience  | `restart-cut.ts`, `restart-resume.ts`, `restart-waits.ts`, `permission-grants.ts`, `client-sends.ts`, `model-fallback.ts`, `archive-files.ts`, `owned-dirs.ts`                                                                                                                                                                                                    |
| 15 Storage     | `storage-overview.ts`, `storage-clean.ts`, `storage-orphans.ts`, `storage-schedule.ts`, `rebuildable.ts`, `dir-size.ts`, `size-cache.ts`                                                                                                                                                                                                                          |
| 15.2 Dreams    | `dreams/` (planner, ticker, settings, brief, proposals, proposal checks, trash), `routes/dreams.ts`, `store/dreams.ts`, `store/dream-nights.ts`, `store/dream-proposals.ts`, `runtimes/claude/dream.ts`, `revert.ts`, `mods/dreaming/`, `mods/dreams.ts`                                                                                                          |
| 16 Audit       | `audit.ts`, `store/audit.ts`                                                                                                                                                                                                                                                                                                                                      |
| 17 Mods        | `mods/`, `shared/src/mods.ts`, `packages/mod-api/`; [Mods](mods.md) is the authoring guide                                                                                                                                                                                                                                                                        |
| 18 Public      | `access.ts`, `routes/share-public.ts`, `share-preview/`, `converter.ts`, `rate-limit.ts`, `security-headers.ts`                                                                                                                                                                                                                                                   |
| 19 Client      | `http.ts`, `etag.ts`, `devices.ts`, `shared/src/lenient.ts`, `ui/src/lib/poll-loop.ts`, `ui/src/lib/stale-build.ts`, `ui/src/lib/app-update.ts`, `server/src/ui-shell.ts`, `ui/build/dist-swap.ts`, `ui/src/lib/uploader.ts`                                                                                                                                      |

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
  read such a row by its JSON, so every view shows it as before. The browser asks for runtime rows
  as events (`wire=events`), which `transcript.ts` projects from the cut, redacted copy; a client
  that does not ask gets the stored form (RT-6).
- A runtime's message is stored with kind `sdk` and read by the runtime its `runtime` column names
  (`shared/src/runtimes/stored.ts`); a row the fill has not reached is Claude Code's, since rows
  of any other runtime are filled when stored. A Codex message keeps the notification as Codex
  sent it beside the agent's own thread id. Codex reports tokens per model call, so at a turn's
  end ingest adds up the turn's calls and estimates their cost from OpenAI's public prices
  (`server/src/codex-spend.ts`, `runtimes/codex/prices.ts`, dated); the turn end marks the cost
  as estimated. Archives keep each row's runtime. Readers that filter on JSON text read such a
  row by its event columns instead (`callText`, `callOrResultText` in `event-filters.ts`), and
  search indexes it from its neutral events (`server/src/events/search-text.ts`) where the search
  trigger indexes Claude Code's rows from their JSON.
- The evidence ledger (`source_item`) keeps one row per item an agent read: kind, container,
  match key, permalink, time and the `spans` that locate the text in a tool result, as JSON
  pointers into the result with an optional character range. The row names its transcript row and
  call, and a foreign key on the row deletes it with the row. A restore reads the ledger again from
  the restored rows (`rebuildSources` in `server/src/sources/record.ts`).
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

- Every stored setting appears in the settings document (`GET /api/settings-doc`). Its sections
  are declared in `shared/src/settings-doc-*.ts` from the zod schemas the settings routes validate
  with, each key described; `server/src/settings-doc/` reads them through the functions the pages
  read. A new column in a settings table fails `settings-doc/columns.test.ts` until it has a path
  or a reason it is state, and a new settings page fails `settings/json/settings-json.test.ts`
  until it has a section. A section's `security` keys are left out of the EA's document. Its
  defaults are in `server/src/settings-doc/defaults.ts`, which the compiler holds complete.

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
- **Memory.** A sandboxed Claude Code agent keeps its auto memory in its own project folder,
  `~/.claude/projects/<slug of its folder>/memory`, through the `autoMemoryDirectory` setting Seti
  passes with `--settings` (`ownMemory` in `runtimes/claude/realise.ts`), so its sessions load the
  folder its dreams edit even in a worktree. The memory folders of the checkouts behind its
  folders are mounted read-only, and `agent-memory.ts` names their indexes in its prompt (SBX-15).
- **Codex agents.** A sandbox planned for the Codex runtime (`launchPlan(task, 'codex')`) holds
  no Claude Code configuration: no `.claude.json`, no `~/.claude` mounts, no plugins, borrowed
  servers or claude.ai connectors. Its grant has `anthropic: false`, so the proxy mints no
  Anthropic credential for it, and its OpenAI key is the connection `codexKeyConnection` names,
  whose placeholder the sandbox also sets as `SETI_MODEL_KEY`. `CODEX_HOME` is `~/.codex` in the
  private home. Everything Codex or its shell reads that the agent could write to change how
  commands run or are asked about is empty and read-only (`sandbox-codex.ts`): in `~/.codex` the
  settings, `.env`, sign-in (`auth.json`), execution environments (`environments.toml`),
  instructions (`AGENTS.md`, `AGENTS.override.md`), command rules (`rules/`, which run commands
  without asking) and agent roles (`agents/`); in the home, `~/.agents` skills and the startup
  files of zsh, bash and sh; and the machine's `/etc/codex` where it exists. Every other setting
  goes on the command line, which wins over any config file (`runtimes/codex/realise.ts`): no
  hooks, plugins, apps, goals, memories, skills, shell snapshot or reviewer model, and the
  sandbox's `PATH` for commands, which drops the helper folder Codex makes in its writable home.
  The session store (`sessions/`, the SQLite files) stays writable so a session can resume; the
  approval policy Seti sends with every resume and turn overrides what it holds. `AGENTS.md` in
  the agent's folders reaches its model as `CLAUDE.md` does for a Claude agent. Seti's own tools
  reach Codex through a relay (`tool-relay.ts`): the node serves each of the agent's tool servers
  on a unix socket in the agent's run folder, which only its sandbox mounts, and Codex starts
  `socat` to join that socket to its stdio. The socket is the agent's identity, so no token enters
  the sandbox, and every call runs on the control plane with the checks a Claude agent's calls get.
  The shared tools are the same stdio program as for Claude Code, with the agent's connection
  variables passed to it by name.
- **Permissions.** Claude Code runs in its `auto` permission mode with Seti's rules, and its
  auto-mode classifier is the classifier of PERM-2. In auto mode Claude Code drops broad shell
  allow rules, so the classifier also reviews a sandboxed agent's shell commands. Where auto mode
  is unavailable Claude Code starts in `default` mode and every call no rule allows becomes a
  request. Bypass is Claude Code's `bypassPermissions` mode, which still applies ask rules and deny
  rules. The repeat guard and review rules are `PreToolUse` hooks, so they hold in Bypass. Seti's
  own evaluator (`policy/`) decides each call beside Claude Code in shadow and changes no outcome:
  its hook answers at once and decides on a later turn of the event loop. `shadow-hooks.ts` reports
  each comparison to the control plane as a `policy.compared` journal entry, which `policy_shadow`
  counts per day, kind, step and rule ref, with no input, command, path or rule text; it also
  counts decisions that failed or took over 50 ms (PERM-12). `pnpm seti:doctor` shows the last seven
  days, and `GET /permissions/shadow` and `seti_overview` with `permissions` read the counts.
- **Runtimes without a classifier.** An adapter declares in `capabilities.gate.classifier` whether
  its runtime has a classifier to defer to. Without one the evaluator asks where it would defer,
  keeps the sandbox's built-in shell allow in auto mode only for a line it fully reads, and lets a
  line run that its own read-only list (`policy/read-only.ts`) passes: listed commands run
  directly, reading inside the working directories, with no redirect, substitution, variable or
  wrapper. Claude Code has a classifier, so this changes nothing while it is the only runtime.
- **Codex agents' calls.** Codex asks before every command, edit and tool server call, and the
  node hands each ask to the control plane as its neutral call (`call.decide`, `codex-decide.ts`).
  The evaluator reads it under Claude Code's tool names, so the user's rules apply as written: a
  command is `Bash`, an edit `Edit` or `Write`. A guard or deny rule refuses it at once and is
  audited; a review or ask rule asks as for any agent; any other call becomes a request with Allow
  and Deny only and no editable fields, and the answer route refuses Always allow for it. Beside
  each answer the user gives, the evaluator's own verdict is counted in `policy_shadow` with mode
  `codex` and the answer as `user-allow` or `user-deny`; the Claude Code summary leaves those rows
  out. With `evaluator_decides` on in the Codex settings (`codex_settings`, on by default; the
  migration that made it so changed only the column default, never a stored choice), an allow
  from a rule or the read-only list answers without the user. `decideCodexCall` keeps each call
  that waits for the user by request id; turning that setting on runs
  `redecideWaitingCodexCalls`, which settles a waiting request the rules now allow or refuse through
  `answerByRules` (`permission-requests.ts`). The settle is the same conditional update a user's
  answer makes, so the first one wins and the other is refused (PERM-14). A question goes to the user
  as an AskUserQuestion call does. The node's Codex host (`codex-host.ts`) serves the agent's tool
  servers through the relay. Codex runs with `model_reasoning_summary="auto"`, since the models
  Seti offers send no reasoning summary unless asked; its reasoning items carry the summary, which
  the projector serves as a `reasoning` event, and never the sealed `encrypted_content`, which stays
  in Codex's session files in the sandbox's private home (RT-14). Codex is asked not to stream item
  parts or the turn's running diff,
  so a Codex agent's rows are its whole items; a line Codex wrote that Seti cannot read is shown
  live and not stored.
- **Symlinks.** `decide` reads no disk. Before it runs, the shadow lists the paths a call names
  (`policy/named-paths.ts`) and resolves them where the session runs (`resolve-paths.ts`); links
  above a working directory or home do not count. A deny or ask rule matches a path as given or
  where it leads; an allow rule and the working directories need both, and a path that leads
  nowhere known, such as a link loop, is never allowed by a rule.
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
  (HST-2), probes capabilities through `server/src/runtimes/claude/probe-launch.ts` (HST-4), and
  serves HTML previews under the policy in `server/src/html-preview.ts` (HST-5).

## Writing a runtime adapter

A runtime adapter is the only code that starts and talks to one agent runtime, such as Claude
Code. The conformance suite is its contract: an adapter is done when it passes every case that
applies to it, or the case is a recorded gap with its reason.

### The interface

`server/src/runtimes/adapter.ts` defines a `RuntimeAdapter`: an `id`, its `capabilities`, and two
steps.

- `realise(spec, launcher, host, abortController)` turns Seti's `SessionSpec` into what the
  runtime starts from. The launcher decides where the process runs and with which environment.
  The host answers the runtime's permission asks and serves Seti's own tool servers. Aborting the
  controller ends the session.
- `open(realised, input, rewind)` starts or resumes the session, at a rewind point when one is
  given. Inputs arrive in order as `SessionInput`s, and the session begins work when its `events`
  are first read.

The `RuntimeSession` that `open` returns yields `SessionReport`s until the session ends: each
runtime message with its neutral events and what the session half reads from it, what became of
each input, and how a rewind went. It offers `interrupt` and `close`, and the optional controls
(`retract`, `stopBackground`, `toolServers`, `setPolicy`, `setMode`) only where the runtime can do
what they do. An absent control is a normal state.

Two rules hold for every adapter. It never starts a process itself: it calls `launcher.spawn`, and
it refuses a sandboxed launcher that has no spawn. It adds no credential to the process's
environment: inside the sandbox, the only keys are the placeholders the launcher sets for the
egress proxy.

### One-shot calls

Every runtime also answers one question with no tools, for a second opinion: its
`capabilities.oneShot` (`server/src/runtimes/one-shot.ts` holds the types; `claude/one-shot.ts`
and `codex/one-shot.ts` the runtimes' parts), read through `oneShotFor`. It opens a new
session that offers the model no tool, refuses any call it makes without asking anyone, and keeps
nothing to resume: Claude Code with no tools, settings or tool servers, one turn and no saved
session; Codex with no tool server, an ephemeral thread and every ask declined. `runOneShot`
reads its one turn and returns the answer, its tokens and its cost, reported or priced from the
tokens; it ends the session on a time limit, on the caller's signal, past an output token limit,
or when the model keeps calling tools.

A one-shot runs in a bare maintenance sandbox (`maintenanceLauncher` with `bare`): an empty
folder of its own, none of the agent's folders, memory or Claude Code state, and a proxy that
reaches only the model provider, with the agent's Claude login or the connection that carries its
OpenAI key. The request names the runtime's program where Seti installs it (`runtimeProgram`),
as a session's spec does. Cases OS-1 and OS-2 cover every adapter's one-shot, asking the model
the target's `oneShotModel` names.

### The conformance suite

`server/src/runtimes/conformance/` holds the suite. `describeAdapter(target)` registers a test per
case. The cases live in `cases-<area>.ts` by area: lifecycle, interrupts, queued input, reports,
events, tool calls, permission asks, questions, subagents and plans, launch, failures and
one-shots. Each
case names the protocol requirement or interface member it proves. A case waits at most two
seconds for anything and finishes in milliseconds when it passes, so "never hangs" means "settles
within the bound". A target whose rig runs a real program may set a longer bound with `boundMs`.

A case that does not apply to the runtime is skipped with the reason, read from the adapter's
`capabilities` or the target's profile. A case the adapter is known to fail is listed in the
target's `gaps` with the reason; it runs expecting the failure, so a fix makes the test fail until
the entry goes. A case is never weakened to make an adapter pass.

`suite.test.ts` runs chosen cases against deliberately broken adapters and expects each to fail,
so the suite cannot pass vacuously. `isolation.test.ts` checks that no production module imports
the suite or the scripted adapter, and that no adapter module imports `node:child_process`.

### The target

A target is the adapter as the suite drives it, in `runtimes/<id>/conformance-target.ts`:

| Member    | What it holds                                                                                                                                                |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `adapter` | The adapter itself.                                                                                                                                          |
| `profile` | What the runtime does that `capabilities` does not state yet: turn starts, threads, plans, steering, input reports, background work, the kinds Seti decides. |
| `gaps`    | Known failures by case id, each with its reason.                                                                                                             |
| `host`    | The host the adapter gets, built from the suite's neutral answers.                                                                                           |
| `rig`     | A fake runtime that plays a neutral script and records what it saw.                                                                                          |
| `oneShot` | The runtime's one-shot and a model it offers, where it has one.                                                                                              |

The rig is the part an adapter's author writes. It turns each step of a neutral script (say,
think, call, hold, subagent, compact, exit, and the rest in `script.ts`) into what the runtime
would send, through the adapter's own transport. It records the processes started through the
launcher and any started outside it, and the tool calls that ran, and it can kill the newest
process from outside.

A rig may also run the vendor's real program. The Codex rig starts the pinned `codex` binary named
by `SETI_CODEX_BIN` through `conformance/real-process.ts`, answers its model calls from a scripted
Responses API (`codex/conformance-responses.ts`), and puts a login shell profile in the program's
home that prints each scripted command's output instead of running it. Without the variable its
cases are skipped. `pnpm --silent --filter @seti/server run codex-binary <folder>` fetches the
pinned binary with the same code Seti installs it with (`codex-fetch.ts`), checks it against
`codex/pin.json` and prints its path; CI runs the cases with it.

The rig drives Codex outside Seti. `codex-proof.test.ts` and `codex-proof-split.test.ts` run the
same binary as an agent of Seti: started by the runner in the agent's sandbox, its model calls
through the agent's egress proxy, its calls answered through permission requests and questions,
and Seti's tools through the relay, in one process and with a split node. The proxies reach a
local HTTPS stand-in for `api.openai.com` through `routeEgressForTests` in `task-proxy.ts`, which
only test files call (`egress-seam.test.ts` holds that); the split node starts from the test-only
entry `test-codex-node.ts`. They run where `SETI_CODEX_BIN` is set and the sandbox works, and CI
fails without either.

### The scripted adapter

`server/src/runtimes/scripted/` is a second, test-only adapter that passes every case. It drives
a stand-in runtime over standard input and output, one JSON object per line, with permission
requests and input reports on the same pipes and saved sessions kept on a fake machine. It is
shaped like a runtime that speaks a wire protocol of its own, so it is the model for an adapter
that does not go through a vendor library. No registry names it, so no install can select it.

### Adding an adapter

1. Create `server/src/runtimes/<id>/` with the adapter, its projector (the adapter's `project`,
   which the suite also runs on each stored message) and its transport, and keep the vendor's
   package inside that folder.
2. Write `conformance-rig.ts`, `conformance-target.ts` and a `conformance.test.ts` that calls
   `describeAdapter`. Declare in `capabilities` and the profile only what the runtime does.
3. Run `pnpm --filter @seti/server exec vitest run src/runtimes/<id>/` until every case that
   applies passes or is a recorded gap.
4. Add the adapter to `server/src/runtimes/registry.ts`.

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

### How the EA speaks

The EA's manner lives in its base prompt (`ea/src/seti_ea/prompt.py`) and in the short lines Seti
speaks while its tools run (`ea/src/seti_ea/announce.py`). It gives the answer first and stops. On a
call it aims for fifteen words, two sentences at most unless the user asks for detail, never reads
a list aloud and never ends with an offer. In the chat an overview is one line per item. After it
messages or starts an agent it says whom and the gist in a few words, on a call and in the chat, and
never quotes or restates what it sent unless the user asks. Its tone is composed and precise, with
dry wit now and then and none about an error, a refusal or security.

The user's request is the EA's yes. It asks first only for tools that take `confirmed` (EA-3,
EA-4), a public group chat post, stopping several agents at once, and work it proposes itself. It
refuses a security change rather than asking. An ask is one sentence of effect and a short
question; in the chat it ends with exactly "Shall I go ahead?", which shows the Yes and No buttons.

### Call audio

A call is WebRTC through pipecat's SmallWebRTC transport, which runs on aiortc. aiortc has no
settings for speech on a lossy network, so two small modules replace what it creates, and their
tests fail when the pinned aiortc version or the code they replace changes. `aiortc_opus.py`
encodes the EA's voice as 48 kbps mono Opus with in-band FEC and a 10% loss hint, so the browser
rebuilds a single lost packet instead of concealing it. `aiortc_jitter.py` buffers the user's audio
three packets deep and skips a packet the network lost, where aiortc's own buffer also drops
packets that arrived after it.

`link.py` watches the caller's microphone audio: while it is missing, the EA's speech waits up to
8 s and goes on where it stopped, and the gate forgets the user's last words (EA-18). The browser
reads `getStats` every two seconds (`call-quality.ts`) and reports the call's loss, filled-in
speech, jitter, round trip, path type and reconnects with its call end, as numbers only; the EA
logs one line per call with the user's audio loss, drops and the seconds of speech it held.

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
