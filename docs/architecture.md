# Architecture

This page records the decisions the code does not make obvious. The code is the reference for
everything else.

## One process owns every session

```
 browser --HTTP, SSE--> seti server (Node, 127.0.0.1:3006)
                          |-- routes, store (PostgreSQL), audit chain
                          |-- runner: one Claude Code process per open task, each under bwrap
                          |-- egress proxy per task, reached through a unix socket
                          |-- pollers and schedulers: PRs, reminders, backups, EA inbox, webhooks
                          '-- Redis: shared caches and task event relay
 EA (Python, 127.0.0.1:3007) <--/api/ea proxy-- seti server --> EA polls inbox, context, search
```

A task's first message opens a Claude Code process through the Agent SDK and keeps it open between
turns, so follow-ups, interrupts and PR updates reach the same session and background subagents
keep running. The open sessions live in the server's memory (the `live` map in
`server/src/runner.ts`), so one server process owns them all: a restart marks running turns interrupted
(the next message resumes the session), and a second process cannot steer another's sessions.

With Resume after restart on (the Lifecycle settings page, on by default), Seti sends each agent a
restart cut off one message in its own session once it is listening again, two seconds apart:
"Seti restarted while your last turn ran. Check what finished before the cut, without repeating
any step that may already have run, then continue." It goes the way a follow-up from the user goes,
marked as written by Seti, and is audited as `task.resumed_after_restart` with the actor `system`.
`markRestartCut` in `server/src/restart-resume.ts` picks the agents before startup clears their
reason lines: an agent that was waiting on the user (a permission request, a change request, an MCP
sign-in or a stall) or is archived stays interrupted for the user, as does every agent while the
setting is off. An agent picked to resume is left seen, so it raises no Needs you row or push; one
whose resume cannot start falls back to the interrupted notice. An agent the user messaged first is
skipped, and each agent resumes at most once per start.

Restarting a session from the agent's settings ends its process with the background work in it and
opens the next one at once, resuming the same session id, so its MCP servers reconnect and report
their status before the next turn instead of during it. A running turn is stopped first only when
the user asks for that.

Retrying a turn sends the agent's last message again as a new turn, with its attachments; it is
refused while a turn runs, and a shell command or a message taken back from the queue never counts as
the last message. A message the EA or another agent wrote goes again marked with who wrote it. The
UI offers it under the transcript when a turn errored or a restart cut it off, and the EA and agents
at Full can ask for it with `retry_agent_turn`.

Each open task costs a Claude Code process of about 300 MB, which caps one host at a few dozen
concurrent tasks. The path past that is runner workers that claim tasks from Postgres
(`FOR UPDATE SKIP LOCKED` with a lease), singletons such as the PR poller and reminder ticker on
one elected process, and per-task cgroup limits beyond the memory and CPU caps below. The storage split
below exists so that path needs no further migration.

## A side chat forks the session and keeps nothing

Ask aside answers a question from an agent's context without the agent seeing it. The bundled mod
`mods/side-chat/` owns everything the user and the EA see of it: `/btw <question>` in the composer,
Ask aside in the command palette and in the More actions menu on a phone or a panel of the grid,
the dock the answers show in, its routes and the `ask` action. The engine that forks the session
stays in core, in `server/src/side-chat/`, since no mod runs programs; the mod reaches it through
the bundled-only `tasks.ask` capability. Seti handles `/btw` itself whether the mod is on or off:
its catalog entry replaces any Claude Code or plugin command named `btw`, and the messages route
refuses a `/btw` prompt, so the question never queues for or interrupts the agent. Each question
starts a short-lived Claude Code process that resumes the
agent's session with `forkSession` and `persistSession: false`, so it reads the conversation as last
written to disk and writes nothing back: the agent's process, session file and transcript stay as
they were, and a running turn goes on. A pending rewind forks at the rewind point with `resumeSessionAt`. The fork runs in the agent's
sandbox, egress proxy and permission rules, with only Read, Glob and Grep, no MCP servers or hooks,
and in a `side_chat` memory scope of its own (`server/src/side-chat/options.ts`).

A side chat keeps its questions and answers in the server's memory only, for up to eight
questions, and forgets them when the user closes it, after 30 idle minutes or on a restart. Its
cost is the fork's total less the total the session file saved, added to the agent's cost and to
today's. The audit log records that a side chat started, never what it asked or answered. The EA
asks through `run_mod_action` and agents at Seti control Full through `mod_side-chat_ask`; an agent's
fork gets no tools. Turning the mod off closes every open side chat and stops its answers.

## PostgreSQL holds the truth, Redis only helps

PostgreSQL 16 is the only store. Migrations run at startup under an advisory lock, writes that
belong together run in transactions, and the audit chain appends under a row lock on its head, so
several processes can share one database safely. The database is reached on its unix socket with
peer authentication, so no database password exists.

Redis holds only what can be rebuilt: GitHub PR lists and the GraphQL budget, capability and
account probes, the EA's live context snapshot, and pub/sub for task events and group chat
messages across processes. It keeps nothing on disk and never holds a token. Losing it costs cache
misses, not errors, which is why `SETI_REDIS_URL=off` is a supported mode.

## The live instance runs from its own worktree

`seti.service` runs from `~/seti-live`, a detached worktree at a tested commit. Development in
`~/seti`, including agents working on Seti itself, rebuilds and restarts nothing live, and the
sandbox leaves `~/seti-live` out of every agent's mounts. A deploy is an explicit checkout, build,
restart and health check.

## Agents run sandboxed with credentials outside

Every agent runs in Claude Code's `auto` permission mode with Seti's allow, ask and deny rules
(Settings, Permissions). The rules and the shell guard decide first, and edits in the agent's
directories go ahead. A classifier model then allows or turns down each other call. A call it
turns down never reaches the user: the agent gets the reason, the transcript shows the failed
call, and the audit log records it. A call the classifier cannot decide, or one an ask rule
matches, waits as a permission request until the user answers it, and the agent shows in Needs
you meanwhile. Where auto mode is unavailable, Claude Code starts in the `default` mode, and every
call no rule allows waits as a request, edits in the agent's directories included. In auto mode
Claude Code drops broad shell allow rules, such as `Bash` alone or an interpreter prefix, so the
classifier also reviews a sandboxed agent's shell commands. Unsandboxed agents get no prefix rules
for local shell commands, because flags such as `--output` and `rg --pre` write files or run
programs; Claude Code runs the safe forms of read-only commands without asking. A shell guard
refuses `rm -r` outside the agent's directories, `xargs rm`, forced cleans, `--output` outside
them, killing processes by name, and writes under credential folders, whatever the rules say;
outside the sandbox it also refuses `find -exec`, `rg --pre` and `gh --web`.

Bypass, in an agent's settings on the Access tab, runs that one agent in Claude Code's
`bypassPermissions` mode for 2, 8 or 24 hours, so it never stops on the classifier or on Claude
Code's shell safety asks. It is off for every agent by default, and only the user turns it on or
off: the server refuses the EA and agents' Seti tools. Deny rules and the shell guard still refuse
in bypass, the repeat guard below still asks, ask rules no longer ask, and the credential deny
rules and the sandbox stay as they are.
A process gets Claude Code's bypass flag only while Bypass is on, so turning it on reaches a
process that started without it at its next turn; turning it off, or its end, switches the running
process back to `auto` at once. Each on, off and end goes to the audit log and the transcript.

The repeat guard (`server/src/repeat-hooks.ts`) stops an agent that runs the same tool call again
after two identical results, before the third run, and asks the user through the same permission
request path, so the agent waits in Needs you with a reason line such as "Runs the same Bash
command again after 2 identical results". It counts per thread, the agent and each subagent
apart, from PreToolUse and PostToolUse hooks, and compares calls and results by hash only. A
different result, a different call in between, or a message from the user starts the count again,
so polling that makes progress never asks. Because it is a hook rather than a permission rule, it
asks in Bypass too; a command the shell guard refuses is left to that guard. Allow runs the call
once and starts the count again, Always stops asking about that exact call while the agent's
process runs, and Deny tells the agent why. The switch, on by default, is under Repeats in
Settings, Lifecycle.

Settings shows the
rules agents load from Claude Code's own settings files read-only. Sandboxed agents may edit any
file they can reach, and run any shell command the classifier allows, so the sandbox stays the
boundary for them. The whole Claude Code process of a task, and each `!` command,
runs under bubblewrap with its own pid, network, IPC and UTS namespaces:

- It sees the system read-only, its own home root and `/tmp`, the task's directories, the
  top-level non-dot folders of the home directory and package caches read-write, and toolchains
  and Claude Code configuration read-only. Dotfiles, `~/.seti`, `~/.ssh`, cloud and GitHub
  credentials, `/run/user` and the database sockets are not mounted.
- `.git/config` and `.git/hooks` are read-only in every mounted repo, since they run code when the
  repo is used outside the sandbox.
- Its network namespace has only loopback. `socat` bridges `127.0.0.1:3128` to the task's egress
  proxy in Seti, its only way out, which allows the configured hosts and refuses the rest.
- No credential enters the sandbox. Claude Code and `gh` hold placeholders; the proxy terminates
  TLS for Anthropic, GitHub, signed-in MCP server hosts and the hosts of the task's connections
  with Seti-local CAs that are name-constrained to those hosts and whose keys stay outside, and
  puts the real credential on the request. GitHub tokens come from the task's credential,
  chosen by the owner the request names. A connection's placeholder is swapped for its value only on
  its hosts, and a request carrying it elsewhere is refused. MCP sign-ins and connection headers share
  one rule path in the proxy; minted tokens are made and cached by the server and retried once after
  a 401.
- MCP servers an agent leaves out are denied to its Claude Code, left out of its `.claude.json`,
  and neither allowed nor signed by its proxy; claude.ai connectors are refused by id.
- SSH hosts and AWS are off by default and turned on per task or by default, like every other
  access item (`server/src/agent-access.ts`). An enabled host is usable only with a login (user
  and key) in the task's credential for it and each jump host. A task's ssh config,
  known_hosts, its own ssh-agent and the proxy's allowed first hops cover only its usable hosts and
  their jump hosts; ssh goes through the proxy with pinned host keys, and the agent holds only the
  keys of those logins, pinned per host with IdentitiesOnly. AWS gets
  short-lived credentials of the role in the task's credential from the proxy,
  never the host's own.
- A task fails to start when the sandbox is unavailable. Unsandboxed tasks are a per-task choice
  the user makes with the Sandbox switch on the start page, badged in the UI and audited. The EA
  is refused, and an agent that starts another always starts it sandboxed.

## Each agent runs in a scope with memory and CPU caps

Seti starts an agent's Claude Code process, sandboxed or not, each `!` command and the short-lived
rewind helper through `systemd-run --user --scope`, so the process tree lives in a transient scope
of its own with `MemoryMax` and `MemorySwapMax` set (by default 6 GB and 1 GB; Settings, Resources
sets the default and an agent's settings can override it, and a change reaches running scopes at
once through `systemctl set-property`). Above `MemoryMax` the OOM killer stops a process inside
that scope instead of earlyoom picking a large process anywhere on the host.

- `OOMPolicy=continue` keeps the rest of the tree running when one process, such as `tsc`, is
  killed, so Claude Code sees the failed command and goes on.
- The scope is `BindsTo=` the unit the server runs in (`seti.service` live), so a restart stops
  agents as it did when they were the service's own children, and `--collect` leaves no failed
  unit behind.
- Every process in a scope starts at the scope's `oom_score_adj` (200 under the user manager), so
  the kernel used to stop whichever was largest, Claude Code included. Seti looks at each scope's
  `cgroup.procs` every 100 ms and raises every process below Claude Code, other than the sandbox
  launchers and its proxy bridge, to 800. The kernel then stops the largest tool first and Claude
  Code only when nothing else is left. Unprivileged processes may raise their adj but not lower it
  under the floor the user manager set, so Seti raises the tools rather than lowering Claude Code.
- Seti watches each scope's `memory.events`; kills in one burst become one note in the agent's
  transcript. Where the kernel log is readable (`journalctl -k`), the note names what was stopped
  ("tsc was stopped: the agent's process tree hit its 6 GB memory cap"); otherwise /proc tells
  whether Claude Code itself died, which ends the turn. The Processes view shows the scope's memory
  against its cap.
- The agent learns its cap from its system prompt and `SETI_MEMORY_CAP_MB`, and Node tools default
  to a heap of 70% of the cap through `NODE_OPTIONS`; a heap size the agent sets wins.
- `MemoryHigh` is `infinity` by default. Throttling only reclaims what can be reclaimed: with swap
  full, a process held over `MemoryHigh` stalls for minutes rather than reaching `MemoryMax`. A
  throttle point stays available as an advanced setting, and its first `high` event becomes a
  transcript note too.
- Hosts without a user manager or a delegated memory controller, such as CI containers, run agents
  without a scope; `SETI_MEMORY_SCOPES=off` does the same.

The same scope holds the agent, its subagents and every shell they start to a CPU cap. Each scope
gets `CPUWeight=50` and `CPUQuota=` (by default 300%, three cores; Settings, Resources sets the
default between 50% and nproc x 100% or turns the ceiling off, an agent's settings can override it,
and a change reaches running scopes at once through `systemctl set-property`).

- The scopes are siblings of `seti.service`, `seti-ea.service` and the user's own tmux and terminal
  scopes in the user manager's `app.slice`, which all keep the default weight of 100. Under
  contention every agent gets half the share of Seti or of an interactive session, so the API and
  UI stay responsive however many agents are busy; with spare cores the weight changes nothing.
- The weight shares a scope as a whole, not per thread: an agent running sixteen busy processes
  gets the same share as one running a single process, and never more than its quota. At the quota
  the kernel pauses the scope until the next 100 ms period; the Processes view and
  `get_memory_cap` show its usage over a short window from `cpu.stat` and a calm note when
  `nr_throttled` grew.
- The agent learns its core count from its system prompt, so it sizes build and test workers to it.
- The cpu controller must be delegated to the user manager (`cgroup.subtree_control` of
  `user@<uid>.service` lists `cpu`, as on Ubuntu 24.04 with systemd 255). Without it Seti starts
  scopes with the memory cap alone and the doctor says so.
- Scopes never outlive the Seti that started them: a restart stops them through `BindsTo=`, and a
  new Seti stops what a crashed one left behind, so every running scope was started with the
  current caps or moved to them since.

## Reminders run in a locked-down Node process

A reminder's script runs once per run in a fresh child Node process, never in the server. Node
starts with `--permission` and no grants, so the script cannot read or write files, start
processes or workers, load addons or WASI, or open the inspector; its environment is empty. Node
24's permission model has no network control, so two more layers close it. When bwrap works on the
host, the process starts inside `bwrap --unshare-all` with a read-only root and empty `/home`,
`/run` and `/tmp`: no network namespace, no other processes to signal, no unix sockets of Seti's
database or Redis. `server/src/script-sandbox.ts` builds that command and watches the process
tree's memory, for reminders and for third-party mod logic alike. Inside the process, the runner
(`server/src/reminders/runner.ts`) removes
`fetch`, `WebSocket` and the real `process` object, and a module hook refuses every builtin but a
few pure ones (`util`, `url`, `buffer` and the like), which keeps out `net`, `http`, `dns`,
`child_process`, `fs` and `module`. Without bwrap, Seti logs once that reminders run without
network isolation, and the runner's lockdown is the only network barrier.

The server sends the script and its context as JSON on stdin and reads one JSON line back. It stops
the process after 5 seconds of script time, when its resident memory passes 256 MB (the V8 heap is
capped at 64 MB), or when it writes more than its output cap; the runner caps the message at 2000
characters and the state at 16 KB. A reminder runs on an interval or on a 5-field cron schedule in
an IANA timezone. A single ticker every 10 seconds, plus one timed for the soonest reminder, claims
due reminders with `FOR UPDATE SKIP LOCKED` and moves each one's next run ahead as it claims it,
so a restart, an overlapping tick or a second Seti never fires one twice; a run lost to
a crash is skipped, not repeated. An interval reminder that missed slots while Seti was down runs
once and keeps its grid. A cron reminder runs its newest missed slot once when that slot is at most
an hour old and skips older ones. Messages take the same event path as webhooks and pollers.

## Pollers run in the server, not in a sandbox

A poller's script runs in QuickJS compiled to WebAssembly inside the server process, with a fresh
engine per run, instead of as a command in a bwrap sandbox. A poll needs no files, CLIs or model,
only HTTP and a little JSON, so an engine that can do nothing but call the host functions it is
given (a guarded `fetch`, a feed parser and a log) is a smaller surface than a process, starts in
milliseconds and needs no native build. Its memory is capped by the WebAssembly memory's maximum,
because QuickJS's own limit counts allocations rather than bytes in this build, and an interrupt
handler stops it after a second of compute without awaiting. The engine itself,
`server/src/quickjs/engine.ts`, is shared with third-party mod logic; `server/src/pollers/engine.ts`
gives it the poll prelude. Pollers feed the same event path as
webhooks (`server/src/channels/publish.ts`), so subscriptions, routing and the delivery log are
shared.

The engine runs on a small pool of worker threads (`server/src/pollers/pool.ts`, two by default),
not on the event loop, so a busy script delays no API request. The server reads the poller's
secrets and sends the worker one message per run (script, state, limits, allowed hosts and the
secret values that poller may use); the worker makes the guarded requests itself, replaces every
secret value in what it returns, and keeps nothing after the run. The contract lives in
`worker-protocol.ts` as plain values, so moving pollers to a separate process means changing only
the transport. A worker that overruns its run's timeout by 2 seconds is terminated from the server,
and one that crashes or passes its 128 MB heap fails only its own run; the next run starts a new
worker. Each run's engine is dropped whole rather than freed, since this QuickJS build's
teardown asserts after a garbage collection inside a promise job; a trap inside the engine reads as
"The script ran out of memory" and retires its worker too.

## Mods add to Seti through registries with disposers

A mod is a package described by `seti-mod.json`, validated by `modManifest` in
`shared/src/mods.ts`. Seti reads everything under `contributes` before any of the mod's code runs,
and a mod reaches Seti only through `@seti/mod-api` (`packages/mod-api/`). There are three tiers:
bundled mods and theme mods, which ship with Seti, and third-party mods, which the user installs. Seti's own mods live in `mods/<id>/`, one pnpm package each, built
and reviewed with Seti. A theme mod is a manifest and a token file with no code and no
capabilities; `manifestProblem` refuses a theme-tier manifest that adds anything but themes. An ESLint rule lets `mods/**` import `@seti/mod-api`, `react`, `lucide-react` and the
mod's own files, nothing else. Third-party mods never run in Seti's process or its UI; how they
run is at the end of this section.

Discovery is a static index. `server/src/mods/bundled.ts` lists each bundled mod's server half in
`BUNDLED_MODS` (among them `weather`, the daylight band, and `whats-new`, the changelog and
update check; both on until the user turns them off), each theme mod's manifest in `THEME_MODS`,
and `mods/sample/`, which only tests use, in `TEST_MODS`, loaded with
`SETI_TEST_MODS=1` in a development or test run. `bundled.test.ts` fails when a folder in `mods/`
is missing from the index, is named differently from its manifest's id, or has a manifest this
Seti cannot run, so `pnpm check` catches an unregistered mod.

The mod host (`server/src/mods/host.ts`) validates every manifest at startup. A mod whose manifest
is invalid, asks for a mod API range this Seti does not offer (`MOD_API_VERSION`), or uses a
contribution point Seti has no registry for yet stays off, and Settings, Mods shows the reason.
Starting a mod registers what its manifest declares, then runs its server half with a
`ServerModApi`. Every registration returns a disposer, and the host keeps them per mod, so turning
the mod off disposes them all and leaves nothing behind. A start that throws midway disposes what
it made and leaves the mod off. The user's choice lives in `mod_state`; a mod without one follows
its manifest's `defaultEnabled`.

Each contribution point is a `Registry` (`shared/src/registry.ts`): entries by key, a key taken
once, so no mod can shadow core or another mod. Core registers its own entries through the same
registries, so behaviour is unchanged while no mod is on. Names are scoped by the mod id as
`<mod>.<name>`.

| Point           | Registry                                                           | Takes effect    |
| --------------- | ------------------------------------------------------------------ | --------------- |
| Slash commands  | `slashCommands` in `server/src/mods/points.ts`                     | at once         |
| Commands        | `modCommands`, run through `server/src/mods/commands.ts`           | at once         |
| Input hooks     | `inputHooks` in `ui/src/lib/input-hooks.ts`                        | at once         |
| Host proxies    | `hostProxies` in `server/src/subdomain-proxy.ts`                   | at once         |
| PR decorators   | `prDecorators` in `server/src/pr-decorators.ts`                    | at once         |
| PR chips        | `prChips` in `ui/src/lib/pr-chips.ts`                              | at once         |
| Status markers  | `statusMarkers` in `ui/src/lib/status-markers.ts`                  | at once         |
| Agent accents   | `agentAccents` in `ui/src/lib/status-markers.ts`                   | at once         |
| Notifications   | `notifyKinds`, with the mod's `<mod>.<kind>`                       | at once         |
| Audit kinds     | `modAuditKinds`, recorded as `mod.<id>.<kind>`                     | at once         |
| File extensions | `extensionKinds` in `shared/src/files.ts`                          | at once         |
| Kinds, pages    | `kindViewers`, `pageExtensions` in `shared/src/file-viewers.ts`    | at once         |
| Routes          | `modRouteEntries`, under `/api/mods/<id>/`                         | at once         |
| Demo routes     | a route's `demo` flag, which the demo guard asks                   | at once         |
| Settings        | the manifest's schema, values in `mod_settings`                    | at once         |
| Sections        | `sectionRegistry` in `ui/src/lib/sections.ts`                      | at once         |
| Settings pages  | `settingsPages` in `ui/src/panels/settings/pages.ts`               | at once         |
| Status bar      | `statusBarItems` in `ui/src/components/status-bar/items.ts`        | at once         |
| Header band     | `headerViews` in `ui/src/lib/mod-views.ts`                         | at once         |
| About parts     | `aboutParts`, with news dots in `newsEntries`                      | at once         |
| File viewers    | `fileViewers` in `ui/src/panels/files/file-viewers.ts`             | at once         |
| Fence renderers | `fenceRenderers` in `ui/src/lib/fence-renderers.ts`                | at once         |
| Themes          | `themeRegistry` in `ui/src/components/theme/registry.ts`           | at once         |
| Styles          | `MOD_STYLES` in `ui/src/mods/bundled.ts`, added to the page        | at once         |
| Agents layouts  | `agentsLayouts` in `ui/src/panels/tasks/agents-layouts.ts`         | at once         |
| Terminals       | `terminalSources` in `ui/src/panels/terminal/terminal-sources.ts`  | at once         |
| Chords          | `modChords` in `ui/src/mods/mod-chords.ts`, checked against Seti's | at once         |
| Agent docks     | `agentDocks` in `ui/src/panels/tasks/agent-docks.ts`               | at once         |
| Context         | `modContexts` in `server/src/mods/ops/context.ts`                  | new sessions    |
| Public paths    | not available yet                                                  | after a restart |

Slash commands Seti answers itself never reach an agent: every mod's command, such as the side
chat's `/btw`, is listed in an agent's composer and refused as a prompt. A slash command of a bundled mod that is off is
refused too, so it never reaches Claude Code: the composer answers "<Mod> is off" with a Turn on
button, and the palette lists that mod's commands with the same notice.

A mod command is one action with typed arguments, reached four ways from one manifest entry: the
palette (`for: palette`, and a slash command that names it), an agent's More actions menu
(`for: agentMenu`), the EA (`for: ea`, through
`run_mod_action`, its prompt listing the actions of mods that are on) and agents (`for: agents`, as
the seti tool `mod_<mod>_<command>`). `POST /api/mods/<id>/actions/<command>` runs it for the user
and the EA, and agents' tools call the same `runModAction`: it checks the caller against `for` and
the command's `level`, parses the arguments with the zod schema built from the manifest, resolves a
`task` argument to the agent's id, and runs the server half's handler as the mod within
`timeoutSeconds`. A command that `changes` something is audited as `mod.action_run` with the
caller, and the EA asks the user first, as for its own tools that change things.

Keyboard behaviour goes through one core focus API: `PANEL` in `ui/src/lib/panels.ts` marks the
panels focus moves between (`data-panel`), with `data-panel-scroll`, `data-panel-passthrough`,
`data-panel-active` and `data-panel-focused` (the panel a layout of several holds as focused), and
`inputHooks` hands every key to each registered hook, asks hooks whether an Esc, a find field's Enter or a key typed in a terminal is theirs, and draws what a hook overlays, such as a list of its
keys. Vim mode is the bundled mod `mods/vim/`, off until the user turns it on, so Seti itself binds
no single key. An open text file takes the editor keys (find, replace, go to line, F3) in its own
box first (`ui/src/panels/files/find/`), and the Files search and the chat find skip a key it
handled, so Ctrl+F finds in the file while it has focus. Routes hot-toggle because one route,
`/api/mods/:id/*`, hands each request to the entry an enabled mod registered, after the request
passed the same sign-in, origin and body checks as every other API route. A user's request to a
mod's route stays the user's; only the mod's own calls through the mod API run as the mod. A route
the manifest marks `stream` answers with server-sent events; a throw before its first event is an
ordinary refusal.

The UI has a mod host too (`ui/src/mods/host.ts`). It reads `GET /api/mods`, and for each mod the
server runs it registers the files its viewers show, with the same `claimFileViewers` the server
uses, and runs the mod's UI half,
listed in `ui/src/mods/bundled.ts` and loaded as its own chunk. A UI half registers a section,
a band across the app header, a part of Settings, About (listed only while a part fills it) with a
news dot on the way there, a status bar item, a file viewer or its own settings page, each for an
entry its manifest declares. It draws with Seti's own controls from `api.kit`, polls its routes
with `api.poll`, which stops once no view reads them, and reads and saves its settings on the
server, so phone and desktop agree; a mod with settings or notification kinds and no page of its own gets one Seti draws
from its manifest, under the Mods group of Settings. When the server stops a mod, the UI disposes
what it registered. Seti's own sections and settings pages register their names, icons and
groups through the same registries, while their views stay in the app's lazy panels. Every file
viewer and fence renderer comes from a running bundled mod, and a file with no viewer opens as
text or offers its download, with a line naming the mod that is off and would show it. The
`previews` mod draws PDFs with pdf.js, shows CSV, TSV and workbooks as tables, and draws `.mmd`
and `.mermaid` files and `mermaid` fences, with one switch in its settings per format. A viewer or
fence renderer whose manifest entry names a `setting` is registered only while that boolean is on:
`GET /api/mods` lists each mod's `off_switches`, and the UI host registers and disposes those
entries as the list changes, with no restart of the mod. With a format off, or the whole mod
off, a PDF or workbook offers its download, a CSV or diagram opens as text and a fence as code;
the line then names the switch and opens the mod's settings at it, or turns the mod on. Share
pages render all of them as before, since their renderers are core.

Settings, Mods lists each mod with its version, what it may do in plain words, a switch and any
reason it cannot run, and holds the safe mode switch. The EA lists mods with `seti_overview` and
`mods`, which also names the theme shown, the themes on offer and each mod's settings with the
values in force. It turns an ordinary bundled or theme mod on or off, or changes its settings, with
`set_mod_enabled` after the user's yes; Seti checks the values against the manifest and audits the
change as it does the user's. The same tool picks the theme,
flavour and accent without a yes, refusing a theme whose mod is off. Agents at Full get the same
two tools.

A theme mod's `tokens` file holds custom properties scoped to
`:root[data-theme='<mod>.<theme>']`. `ui/src/mods/bundled.ts` bundles every theme mod's tokens
with the page in `THEME_TOKENS`, where they apply only while that theme is shown, and the UI host
registers a theme in `themeRegistry` while its mod runs. The theme the user picks lives on the
server in `user_settings.theme`, through `PUT /api/user`, so every device shows it; light, dark or
system stays per browser. The page shows the chosen theme while a mod provides it and Seti's
default theme otherwise, without changing the choice, so turning the mod back on brings the theme
back. Until Seti answers and the mods have started, the page paints the theme it showed last,
kept in `localStorage`, so a reload does not flash the default. `themes.test.ts` holds every
theme in `mods/` to the default theme's tokens and to AA contrast in each scheme, flavour and
accent it offers.

A mod's settings are one row per key in `mod_settings`, checked against the schema its manifest
declares, and its private data is a key-value store in `mod_data`, at most 64 KB a value and 1 MB a
mod. Disabling a mod never drops either.

A third-party mod runs outside Seti's process. Its package lives in PostgreSQL, pinned by a
SHA-256 over its files and hashed again before each start. Its declarations register through the
same registries as a bundled mod's, but every command, webhook delivery, schedule and agent event
it answers becomes an event for its `logic.js` in the logic pool (`server/src/mods/logic/`):

```text
Seti's process                                       runner child (bwrap + node --permission)
--------------                                       -----------------------------------------
per-mod queues, round-robin  -- event as NDJSON -->  a fresh QuickJS engine per event
op table: checks size, event,  <-- call op+args --   the prelude's frozen `seti` object
  grant, schema, then asMod   -- reply (redacted) ->  handler runs, result back as NDJSON
wall timers, RSS watch, restarts by process id
```

The child reads only its own sources and the QuickJS packages, has no network, environment, child
processes or workers, and holds no secret: a connection's value is added in Seti's process by the
op that sends the request. A call names only an op and its arguments; Seti supplies the mod, its
grants and the event. The op table in `server/src/mods/ops/table.ts` runs each op under `asMod`
with the scopes the user granted, the same handlers bundled mods and views use.

Its views and file viewers are HTML pages in a sandboxed, opaque-origin frame with a hash-pinned
script policy and no network (`server/src/routes/mod-frames.ts`). Seti injects a shim that hands
the page `window.seti` and asks Seti's page for a `MessageChannel` port with the frame's nonce;
`ui/src/mods/bridge.ts` hands the port only to that frame's own window, and relays the page's
calls for its own commands, storage and settings to `/api/mod-frames/<id>/call`, which runs them
as the mod. Status items and theme tokens of a running third-party mod reach the UI through
`/api/mod-live`, as text Seti draws and token CSS Seti rebuilt.

## Archiving packs an agent's folders, deleting removes them

An agent has three kinds of folders Seti made for it: a scratch folder `SCRATCH_ROOT/<title
slug>-<id8>` when it started without a repo or directory (default `~/work`), its workspace
`~/.seti/workspace/<task id>`, and its worktrees in `~/.seti/worktrees`. Archiving moves the
transcript into a compressed row (`task_archive`) and hands the folders to
`server/src/archive-files.ts`, which runs in the background so a large folder does not hold up the
request:

| Folder         | On archive                                                             | On restore                        | On delete             |
| -------------- | ---------------------------------------------------------------------- | --------------------------------- | --------------------- |
| Scratch folder | packed into `~/.seti/archive/<task id>/files-<stamp>.tar.zst`, removed | unpacked where it was             | removed               |
| Workspace      | packed into the same bundle, removed                                   | unpacked where it was             | removed               |
| Clean worktree | `git worktree remove`; its branch stays                                | checked out again at its branch   | `git worktree remove` |
| Dirty worktree | kept, its uncommitted changes saved as a patch in the bundle folder    | already there                     | `git worktree remove` |
| Archive bundle | written                                                                | removed once every folder is back | removed               |

A worktree that something outside Seti removed, such as a disk cleanup, is checked out again on its
repo's base branch the next time the agent's process starts, because the sandbox cannot mount a
missing folder. `server/src/worktree-restore.ts` does this, notes it in the transcript and audits it
as `task.worktree_restored`. Commits on a branch survive; uncommitted changes from before do not.

The bundle leaves out dependencies, virtual environments, build outputs and caches
(`node_modules`, `.venv`, `dist`, `build`, `target`, `.cache` and the like), which a reinstall or
build remakes. Each archiving gets its own bundle name, so a leftover bundle never stands in for a
newer folder; the bundle is read back in full before any original is removed.

Every removal goes through `server/src/owned-dirs.ts`. A folder is removed only when its path is
plain and absolute, it sits exactly one level below its root, it is a real directory rather than a
symlink, its real path stays in that root, the root is neither `/` nor the home folder, and no other
agent, live or archived, has it or anything in it as a working directory, added directory or repo.
The scratch folder is the one named for the task's own id among its working and added directories,
so a directory the user picked is never touched. A folder a process works in (read from
`/proc/*/cwd`) or that git holds a lock in stays, and its agent's files are left pending. Removal is
`fs.rm` on that checked path; no shell runs.

An hourly lifecycle sweep (`server/src/retention.ts`, beside the auto-archive sweep) packs the
folders of archived agents that are pending, including agents archived before bundles existed,
frees worktrees a process held at archive time, and deletes archived agents past the delete rule.
The delete rule (`archive_settings.delete_after_days`) is off by default; it skips pinned agents
and ones with uncommitted changes in a worktree.

Agents also leave folders no task records, such as ad-hoc clones in `~/work` and stray worktrees.
`GET /api/archive/stale-folders` lists the folders in the scratch and worktree roots that no agent
owns or is named for and that nothing changed for 7 days, with sizes, and changes nothing.
`POST /api/archive/stale-folders/delete` takes the paths and `confirm: true`, checks each again and
deletes only those still stale; a linked worktree goes through its main checkout's `git worktree
remove`. The EA reaches both through `get_archive_settings` and `run_archive_sweep`, and its
`archive_agent` and `delete_agent` call the same routes as the UI, so they pack and remove the same
folders.

## Knowledge notes reach agents only after the user approves them

Agents propose short, reusable notes (a how-to, a fact, a gotcha or how an environment is set
up), each with a required verify step, up to five sources and an optional repo scope. Notes live
in `knowledge_note` (`server/src/store/knowledge.ts`) with a status of proposed, approved,
rejected or stale, a generated `tsvector` for full-text search, and the counts of passed and
failed checks. Shapes and limits are in `shared/src/knowledge.ts`.

Every proposal goes through `proposeKnowledge` in `server/src/knowledge.ts`, which refuses
secrets and private paths, holds each agent to 10 waiting proposals and audits the proposal. The
`propose_knowledge` Seti tool, the EA's `propose_knowledge` and Seti's own corrections all call
it, and so should any later source of proposals, such as asking an agent for lessons as its task
ends. Approval, rejection and edits are in `server/src/knowledge-review.ts` and refuse anyone but
the user.

Notes do not reuse context packs. A pack is user-written prose linked to agents and placed whole in
their prompt; a note is a small record with a status, a verify step, sources and a check history,
and only its title reaches the prompt. Notes do reuse revisions: approving a proposal records a
`knowledge_note` revision, and each later edit of a published note records another, so the change
history and revert work as they do for packs and CLAUDE.md files.

`knowledgeContext` (`server/src/knowledge-index.ts`), registered with `registerContextProvider`,
gives each agent at Seti control Self or Full a titles-only index of the approved notes for its
repos plus global ones: the most recently verified first, then the most verified, cut to 1,500
characters with a line counting the rest. Agents read a body with `search_knowledge`. A sweep at
each index build and once an hour marks notes stale when their last passed check is older than 30
days (fact, environment) or 90 days (how-to, gotcha); `verify_knowledge` records a check, and the
third failure in a row marks the note stale and files one correction proposal. A pass brings a
stale note back; so does the user's Approve.

The Knowledge page sits in the Context section with Proposed, Approved and Stale views, and the
Context section shows a count of waiting proposals. A proposal never holds an agent up, so it
never shows in Needs you.

## The EA acts through the same API as the user

The EA is a separate Python process that shares a local token with Seti. It changes things only
through the routes the UI calls, so every change is audited like the user's own and marked as the
EA's. Destructive, outward or unattended actions take two calls, with the user's yes in between,
and it never merges, approves, comments or pushes on GitHub. Its inbox, history and search index
live in Postgres, so nothing it is waiting on depends on in-memory timers across a restart.

The EA never writes into an agent's conversation as the user: it messages agents in the group
chat, publicly or with a direct message, and the agent's transcript shows each one as a group chat
update from the EA. A direct message from the EA joins the agent's running turn at its next step,
or starts a turn when the agent is idle; it never cuts a turn short, which takes `stop_task` and the
user's yes.

The EA's model runs without reasoning, so a reply can say "I'll pass that on" and call nothing.
After every finished reply, spoken or typed, `promises.py` reads the turn back without a model call.
When the reply promised or claimed to message, tell, ask or start an agent, or asked whether to
send what the user had just told it to send, and no tool that reaches an agent ran, the EA gets a
developer note and one more run to do it or say why not. A reply the user cut off keeps the note
for the next turn instead. The check runs once per turn, so it never loops.

The EA reports on its inbox unasked, so those report turns get read-only tools; acting waits for
the user. One exception is per channel: an EA subscription in `act` mode marks its alerts `act` in
`ea_inbox`, and a report turn on act items alone may also send an existing agent a direct message
with `post_team_chat` and `to`, then tells the user what it sent to whom. A public post stays held
in that turn, act items never share a report turn with other items, `start_task` stays held, and
the instruction it writes forbids replying on Slack or to customers. Subscriptions default to
`report`.

## The EA records what its model calls cost and how fast they answer

An observer in each EA pipeline (`usage.py`) turns pipecat's metrics into one record per model
call: time to first byte, prompt, cached and completion tokens, the number of tool calls, the model
and whether it ran on a call, in the chat or as an inbox report. On a call it also records the time
to first byte of speech to text and text to speech. The bot posts the records in batches to
`POST /api/ea/usage`, which only the bot may call and which takes numbers and model names only,
never message text. Seti keeps them in `ea_usage` for 30 days, dropping older rows as new ones
arrive. Settings, EA shows the 7-day median and p95 wait, average input tokens, cached share and
call counts, and `seti_overview` with `metrics` gives the EA and agents the same stats.

## The EA hears the current state of what it watches, needs-you first

A task the EA watches, or whose turn it waits for, reaches its inbox with the same reading
notifications use (`server/src/task-attention.ts`). A turn that ends on a question, or an agent
blocked on a permission request, a change request or a sign-in, is a `needs_you` item; it, a
failed turn and failed CI are urgent. Each watch item carries a coalesce key for its subject: the
task's state, one PR's CI, one PR's merge or close, or its waiting updates. A new event with the key of an undelivered item updates that
item in place, so CI that fails and then passes reads as one item that it passed. Off a call, the
EA holds ordinary watch and channel events until none has arrived or changed for 45 seconds, at
most three minutes, before it posts or reports them (`ea/src/seti_ea/settle.py`); urgent items,
follow-ups, reminders and mentions go at once.

On a live call nothing from the inbox interrupts the user. Items wait in the call's inbox until the
user's next turn ends, then join the context after the user's words with a note to answer the user
first and add the updates in one short "Also," sentence (`ea/src/seti_ea/held.py`). Urgent
mentions, failed CI and critical alerts wait too. The one exception keeps a `needs_you` item, an
agent asking the user or waiting on them, from waiting forever: once the call has been fully silent
for 30 seconds, with no turn open, nobody speaking and no reply due, it gets one short line of its
own (`VoiceDelivery` in `ea/src/seti_ea/inbox.py`). The user's turn ends when pipecat's Smart
Turn model judges it finished, or after four seconds of silence when it sounds unfinished.

## A yes is stored, so it survives restarts and summaries

Every question a gated tool asks goes to Seti's `ea_ask` table with the tool, its arguments, a
summary and the tool's own key for the change (`gate.py`, `asks.py`). Asking the same change again
while the question is open returns the first question, so asking twice never pushes it into the
turn of the yes. The tool result gives the model the question id, and each typed turn opens with
a note listing the open questions. On the user's yes the model calls `confirm_asked` with the ids,
one yes covering every question it listed; a call with `confirmed` still matches by key. Seti
takes a yes only for a question asked in an earlier user turn, or by an earlier EA process, and
only for ten minutes. A typed yes, a spoken yes and a notification's Allow all close the same
question, and an allowed call runs once.

## EA replies show as notifications while no call is live

The EA marks the last written reply of each chat turn unseen in `ea_history.unseen`, with the
questions that turn asked, unless a call is live, where the reply was spoken. An inbox report is
marked unseen only when the attention router sent one of its items to a toast. Every page polls
`GET /api/ea/replies` and raises a toast that stays until dismissed for each unseen message
(`EaReplyToasts`). A page raises none while it holds a call, while its EA chat is on screen, or
while the Active tier is set to Brief or Off, and it waits four seconds after a reply so an EA chat
open on another device can see it first. More than three plain messages, or any while a brief
waits, fold into the one brief toast. Dismissing marks the messages seen in Seti, so every device
drops them, and an open EA chat marks what it shows seen. A reply that asks shows Allow and Deny
for each question: the answer is the user's alone, and the EA takes it at its next inbox poll,
runs the recorded call or leaves it, and replies in the chat.

## One attention router gives each event one surface

Every event that could reach the user goes through `routeAttention` in
`server/src/ea-attention.ts`, which picks exactly one surface: a phone push, a toast on a page with
focus, the live EA call, the brief, or nothing beyond the EA's own history. It decides from the
event's tier, the user's surface for that tier, whether a call is live, whether any Seti page has
focus (`server/src/presence.ts`), and how many pushes went out since the user was last here.

| Tier    | What lands there                                                             | Default |
| ------- | ---------------------------------------------------------------------------- | ------- |
| urgent  | needs-you (asking, blocked, failed, cut off), failed CI, critical alerts     | push    |
| active  | finished turns of agents the EA does not watch, reminders, mentions, alerts  | push    |
| digest  | a watched agent's routine news: a finished turn, CI passed, a merge, updates | brief   |
| passive | what only informs the EA, such as a linked PR                                | off     |

A tier set to push reaches the live call when one is live and the EA carries the event, a page
with focus as a toast while one has focus, and the phone otherwise; with no push device it waits
for the brief. Toast never pushes, so while nobody looks it waits for the brief too. Needs-you is
always urgent, and urgent offers only push and toast, so it always reaches the user. Below urgent,
more than five pushes in ten minutes of one absence wait for the brief; coming back starts the
count over. The tiers live in `notification_settings.tiers`, and Settings, Notifications has one
select per tier. The EA and agents change them through `set_notifications`, and every change is
audited with its actor.

An agent the EA watches or waits for gets no push or toast of its own: the EA's inbox item about
it is its one surface. Seti routes each inbox item when it is delivered (`server/src/ea-deliver.ts`),
stores the route on the item, pushes it with the `ea` kind when the router says push, and marks it
unseen only when the router says toast. Pages read `GET /api/attention` for the agents the EA
carries, and leave their turn toasts and failure toasts to it.

## The brief tells the user what happened while they were away

Away means no Seti page with focus and no live EA call for five minutes (`AWAY_MS` in
`shared/src/attention.ts`). Every visible page reports its focus every 20 seconds, and the EA
polls its inbox with `call=1` during a call, so the server knows when the user comes back. The
first report after an absence builds one brief (`server/src/attention-brief.ts`): the agents that
need the user now, each with its reason line, then one line per agent whose turn ended since the
user left, quoting its `closing_line`, then one line per pushed or digest inbox item about
anything else, quoting the notice's own title. Muted agents and tiers set to off are left out, and
the brief lists at most eleven lines and counts the rest. A brief still waiting when the user
leaves again grows to cover both absences; Seti keeps it in memory only.

Pages show the brief as one toast that stays until dismissed, with the unseen plain EA messages
folded in; a tap on a line opens that agent or message, and dismissing it drops it on every
device. A page that was hidden for the away time also starts its turn toasts afresh, so nothing in
the brief toasts twice. A call that opens after an absence takes the brief from `GET /api/ea/brief`
instead: the EA says its one sentence, such as "Two agents finished and one needs you", keeps the
lines as a note for the call, and gives detail only when asked.

## Group chat handles

An agent takes its handle, such as `@billing`, from its title the first time the group chat sees
it. Renaming the agent gives it the first free handle the new title suggests, unless the new title
still suggests the current one; the change is audited as `team.member_changed` by `system`. The
user and the agent itself can still set a handle directly.

## Direct messages in the group chat

A group chat message can name one recipient, an agent or the EA, in `team_message.to_kind`,
`to_task_id` and `to_handle`. It reaches that recipient like a mention, and a muted agent gets it
at its next turn instead of having it skipped. Every read of the chat passes a reader to the store
(`server/src/store/team.ts`): the user's reads see every message; the EA's routes, the stream and
search see public messages and its own direct ones; an agent's seti tools and its `chat.md` see
public messages and the direct ones it sent or got; and the live context the EA and agents share
holds public messages only. Partial indexes on `to_task_id` and on public rows keep each reader's
page fast.

In `chat.md`, a direct message is headed `### <id> <author>, direct to <recipient>, <time>`, with
`you` for the reader. An agent sends one by starting its append with the line `direct @handle` (or
`direct @ea`) and writing the message below it; `public` on the first line posts to everyone. While
the last message in the file is a direct one, an append that starts with neither is refused with a
note and never posted, and so is a first line that looks like a direct line but does not parse, so
a private answer never lands in the public chat by mistake.

A direct message also lives in the transcripts of its two parties, so transcript reads hide it too.
`hideDirect` in `server/src/direct-privacy.ts` takes the rows of one transcript and the reader from
the request: the user and the transcript's own agent see every row, and anyone else gets
`[direct message hidden]` in a row that carries a direct message it did not send or get. It finds
those rows by shape: a team update of kind `direct`, a `post_team_chat` call with `to` and its
result, a group chat read whose result marks a message `"direct": true`, and a `chat.md` append or
read that holds a direct line or heading. The transcript page, message, digest, history, subtask and
search readers call it, and the live context calls it with no reader at all.

## Home and the shipping metrics count only what Seti stored

Seti opens on Home: a strip of the agents that need the user, a force graph of the agents and what
they reach, and what they shipped. The graph is built in the browser from the agent list, which
already carries each agent's colour, status, repos and running subagents, and from
`GET /api/home`, which adds the counts and the calls running now. The UI polls both every few
seconds; d3-force and the canvas renderer load only with the Home page.

The EA and agents with Seti control read the same counts through `seti_overview` with `metrics`.
`GET /api/home?zone=<IANA zone>` counts the 30 days that end today in that timezone; left out, the
Seti host's. The Home page sends the browser's zone, so its days roll over at the reader's
midnight:

| Count           | Source                                                                                                    |
| --------------- | --------------------------------------------------------------------------------------------------------- |
| PRs merged      | `pr_watch` snapshots in state `merged`, by the time the PR poll first saw the merge, joined to the agents |
| Turns           | turn results in `task_message`                                                                            |
| Time running    | each turn's reported `duration_ms`                                                                        |
| Cost            | each turn's own cost, stored with its result                                                              |
| MCP servers     | `mcp__<server>__` tool calls in the agent's messages                                                      |
| Calls right now | the runner's in-memory open tool calls, with their MCP server and subagent                                |

The counts come per day as well as for the week and the month, so the EA can report today and
compare the week with the 7 days before. The latest merges are the six newest PRs
that merged in the 30 days, each once, with every agent it was linked to.

A PR linked to two agents counts once in the totals and once for each agent, and a link the user
dismissed before the merge does not count. The streak is the run of days with a merge, ending
today or, while today has none yet, yesterday. Archived agents keep their merged PRs; their turns
moved into the archive and are left out. The counts are reused until a message is stored or a PR
merges, and redone at most every 5 seconds. The MCP count reads only the messages stored since the
last read, so a busy install pays for each message once.

## Every stall goes through Needs you

An agent that cannot go on without the user shows in Needs you with a reason line on its row, and
its devices get a high-urgency push. Turn ends set three states: `error` (a failed turn, a rate
limit, a lost login), `interrupted` (a restart cut the turn off) and `asking` (the turn ended on a
question). An AskUserQuestion call is turned down with a note to ask in text, so it ends the turn
asking. Everything that holds an agent up without ending its turn sets `task.blocked`, which
`server/src/task-blocked.ts` keeps. It shows as the `blocked` status, which stays in Needs you
while the agent is open, until it clears:

| Stall                                                                                         | Reason line                                                              | Clears when                                 |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------- |
| A tool call no rule allows, or ExitPlanMode                                                   | `Asks to use Bash: make deploy`, `Asks to approve its plan`              | the user answers, or the turn stops         |
| A change the agent asked for with `request_change`                                            | `Asks for access to api.example.com:443`                                 | the user answers it, or it expires in a day |
| An MCP server's sign-in tool                                                                  | `Sign in to the linear MCP server in Seti`                               | a sign-in finishes, or the next turn starts |
| A running turn with no message for 20 minutes, not counting time a request waited on the user | `No output for 20 min while running`, or the API error it keeps retrying | the session speaks again, or the turn ends  |

A permission request outranks a change request, which outranks a stall; the watchdog (`server/src/stall-watch.ts`) checks the
open sessions once a minute.

## Notifications follow the turn-end path

The server decides every push notification (`server/src/notifications.ts`). A turn-end listener
notifies a finished turn, and a turn or status event that the shared needs-you rule in
`shared/src/tasks.ts` counts notifies as needs you, so a new needs-you state notifies without a
change here. Each goes through the attention router first, which sends it to a push only while no
page has focus and the EA does not carry the agent. The Needs you group and its counts use
`waitsOnYou`, which adds that the user has not opened the agent since its turn ended;
notifications do not, since a turn end is always unseen. Startup notifies the agents a restart cut
off, and marks them unseen. Pushes use Web Push with a VAPID key
pair that Seti makes on first start and seals in the secret store; the `web-push` library encrypts
each payload to the device's keys, and Seti sends it itself, only to known push services. Each
notification carries the agent's id as its tag and push topic, so a newer one replaces an older
one. A visible Seti page reports what it shows every 20 seconds; the server skips a device whose
page shows the agent, and while any page has focus that page raises its own toast and chime
instead of a push.
A finished turn's push and toast both read `task.closing_line`, which the turn end stores
(`server/src/closing-line.ts`): the first line of the turn's result, or else of the last text the
agent wrote in that turn, with credentials redacted. A turn that wrote nothing reads "Ended its turn
without a reply".
Each agent push also carries the Needs you count, which the service worker puts on the app icon
with the Badging API; an open page keeps that badge in step with its status bar.
