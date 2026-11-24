# The SETI Protocol

Status: Draft. Describes the reference implementation, Seti, at its current version, and may change.
Category: Specification.

## Abstract

SETI is a protocol for one user to run many coding agents from one control room. It defines agent
and turn state, how outside events become agent input, what counts as needing the user, and the
trust boundary between user, assistant, agents and extensions. An implementation that follows it
is interchangeable for clients, agents and extensions.

## 1. Conventions

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are to be read as in RFC 2119.

- Each requirement has a stable identifier (`AREA-n`). Identifiers are never reused; Appendix B
  lists the retired ones. A range such as `ENT-1 to ENT-4` skips retired identifiers.
- A number written in a requirement is normative. A named constant (`like_this`) is
  implementation-defined: the limit MUST exist, and Appendix A gives its reference value.
- Lines starting `Why:` are non-normative.
- Times are UTC, ISO 8601. Sizes: KB = 1024 bytes.
- Enumerations are closed. A reader MUST tolerate unknown values (API-7).

## 2. Terminology

| Term           | Meaning                                                                             |
| -------------- | ----------------------------------------------------------------------------------- |
| Control room   | The server that owns all state and every agent session.                             |
| User           | The single owner. The only principal that holds reserved powers (ACT-3).            |
| Agent          | A long-lived unit of work with one conversation, one folder, one session.           |
| Runtime        | The agent program the control room starts and steers.                               |
| Session        | One runtime process bound to an agent, resumable by session id.                     |
| Turn           | One run of the agent from a prompt to a result.                                     |
| Subagent       | A child worker started by an agent inside its session.                              |
| Update         | An input from outside the conversation, delivered to an agent.                      |
| Assistant (EA) | A delegate that acts for the user through the same API.                             |
| Mod            | An extension, bundled or third-party.                                               |
| Delegate       | The EA, an agent using platform tools, or a mod.                                    |
| Credential     | A named bundle of access an agent picks.                                            |
| Connection     | One service's access inside a credential: hosts, a value, a variable.               |
| Channel        | A source of events: webhook, poller or reminder.                                    |
| Subscription   | A link from a channel to an agent or the EA.                                        |
| Workspace      | A named group of agents. Every agent belongs to exactly one.                        |
| Role           | A context text linked to an agent that states its function to itself and its peers. |
| Needs you      | The set of agents that cannot go on without the user.                               |
| Reason line    | One line, at most 120 characters, saying why an agent needs the user.               |
| Outward action | A tool call that changes or sends something outside the agent's folders.            |

The runtime MUST offer: a resumable session id; a hook before each tool call that can allow, deny
or rewrite it; a callback for calls no rule decides; a message queue that can join a running turn
between two steps; an interrupt; a hook at subagent start.

## 3. Entities and state

### 3.1 Agent

- ENT-1: An agent MUST have: `id`, `title`, `cwd`, `sandbox`, `home_access`, `profile_id`,
  `seti_control`, `bypass_until`, `pr_urls`, `input_mode`, `session_id`, `status`, `model`,
  `cost_usd`, `last_error`, `archived_at`, `pinned`, `workspace_id`, `notifications_muted`,
  `status_line`, `unseen`, `asking`, `closing_line`, `blocked`.
- ENT-2: Stored status. A turn start clears each; the turn end clears `running`.

| Stored status | Set when                                                              |
| ------------- | --------------------------------------------------------------------- |
| `idle`        | creation; a turn ends without error                                   |
| `running`     | a message is accepted (queued included); background work reports back |
| `error`       | the result is an error; the session fails or cannot start             |
| `stopped`     | a stop ends the turn; the session is closed mid-turn                  |
| `interrupted` | startup finds the agent still `running`; a resume fails               |

- ENT-3: Display status MUST be the first match of: `blocked` if `blocked` is set; `running` if a
  subagent runs; `complete` if idle, a linked PR merged and every linked PR is merged or closed;
  `asking` if idle and `asking`; else the stored status.
- ENT-4: Every turn end MUST set `unseen`, `asking`, `closing_line` and, on error, `last_error`.
  `unseen` MUST read false while running and MUST clear only when the user views the agent while
  it is not running. `closing_line` is the first non-empty line of the result, else of the turn's
  last text, redacted, at most 120 characters, null while running.
- ENT-7: An archived agent MUST refuse every write but delete, restore and a workspace move (409).
- ENT-8: `home_access` MUST be false for every new agent and MUST only ever change to false.

### 3.2 Turn, session, workspace

| Turn kind | Started by                                        | Prompt author |
| --------- | ------------------------------------------------- | ------------- |
| `user`    | a message the user wrote, a retry                 | user          |
| `updates` | delivered updates with no user text               | control room  |
| `wake`    | background work reporting back in an open session | none          |

- ENT-10: A prompt record MUST carry what applies of: `auto`, `held`, `inputs` (count), `retry`,
  `interrupted`, `queued` (`waiting`, `delivered`, `removed`), `attachments`, `client_id`, `from`.
- ENT-11: Subagent status (`running`, `completed`, `failed`, `stopped`, `unknown`) MUST be
  derivable from the transcript's events alone.
- ENT-13: One process owns every open session. A second process MUST NOT steer them.
- ENT-14: A session stays open between turns; idle with no background work, it MUST close after
  `idle_close`.
- ENT-15: Every new process for an agent MUST resume the stored `session_id`; a change of sandbox,
  credential, tool level, access or working directory MUST apply this way from the next turn.
- ENT-17: Workspace: `id`, `name` (at most 60, unique ignoring case), `position`, `created_at`. An
  agent started without one joins the first by position. The last workspace, and one holding any
  agent (archived included), MUST NOT be deleted.
- ENT-23: A role is a context text, at most one per agent; peers see its first line.

### 3.3 Requests

| Entity                                                                | States                                                      | Holds agent | Settled by                    |
| --------------------------------------------------------------------- | ----------------------------------------------------------- | ----------- | ----------------------------- |
| Permission request (`tool`, `repeat`, `review`)                       | `pending`, `allowed`, `denied`, `cancelled`                 | yes         | user                          |
| Question (`choice`, `yes_no`, `secret`)                               | `open`, `answered`, `dismissed`, `expired`                  | yes         | user; EA relays, not `secret` |
| Change request (`allow_host`, `api_key`, `mcp_server`, `shared_tool`) | `pending`, `allowed`, `denied`, `expired`                   | yes         | user                          |
| Knowledge note                                                        | `proposed`, `approved`, `rejected`, `stale`                 | no          | user                          |
| Delegate ask (EA or mod)                                              | `pending`, `allowed`, `denied`, `expired`, `done`, `failed` | no          | user                          |

- ENT-20: One read MUST list every pending request by kind (`questions`, `access`, `plans`,
  `tools`, `notes`) and MUST offer no way to answer; each kind is answered on its own route.

### 3.4 Update

- ENT-21: An update has `source`, `kind`, `subject`, `title`, `body`, `url`.

| Source      | Kinds                                                                         | Starts a turn in `wake` |
| ----------- | ----------------------------------------------------------------------------- | ----------------------- |
| `pr`        | `ci_failed`, `ci_passed`, `review`, `comment`, `conflict`, `merged`, `closed` | yes                     |
| `channel`   | free text from the event                                                      | yes                     |
| `thread`    | `reply`                                                                       | yes, a bot's never      |
| `agent`     | `idle`, `error`, `stopped`                                                    | yes                     |
| `seti`      | `allowed`, `denied`, `expired`                                                | yes                     |
| `team`      | `mention`, `direct`, `broadcast`                                              | by CHAT rules           |
| `workspace` | `rejected`                                                                    | no                      |

- ENT-22: Update state is derived, not stored: waiting (newer than the last prompt the agent
  read), held (`with_message`), dismissed, quiet (PR-4), read.

### 3.5 Runtime

- RT-2: Every runtime MUST offer a resumable session id, an interrupt, and a stream that marks
  each turn's end and each tool call's start and end. It MUST start through the control room's
  launcher with no credential but the placeholders the launcher sets, and MUST refuse to start
  where the launcher cannot start it.
- RT-6: The transcript stores each runtime message unchanged and serves neutral events computed
  from it. Event types and tool kinds (`shell`, `read`, `edit`, `search`, `web`, `mcp`,
  `subagent`, `question`, `plan`, `think`, `other`) are closed lists. A message with no mapping
  is served as `vendor` and MUST NOT break the rows around it. A client asks for events with
  `wire=events` on transcript pages, messages and streams; without it, runtime rows come as
  stored. Every tool call that starts ends by its turn's end or as background work: a call a
  stop cut before it ran ends as `cancelled`, which reads as stopped, not failed.
- RT-7: Delegates and mods receive neutral events only.
- RT-8: A runtime declares dreams, or none: where its agents' sessions keep memory, and a session
  that resumes nothing and saves nothing, with the runtime's read, search, edit and shell tools and
  the control room's own, and no question tool, subagents, web tools, plugins, hooks or tool
  servers of the user's. Every tool call passes the control room's gate first, which allows or
  denies it and never asks; the runtime's own memory consolidation is off in it.
- RT-9: A runtime besides the default is off until the user turns it on. Its status reads off,
  installing, failed with a reason the user can retry, no key, or ready. While it is not ready, a
  new agent or session on it MUST be refused with that reason; its agents stay readable. A runtime
  that needs a model key MUST also refuse a new agent whose credential holds no connection for
  that key, and its status MUST read "no key", not ready, while the default credential holds none.
  The status MAY name the one connection for that key the default credential lacks, but nothing
  but the user changes a credential or connection for it. Only the user changes a runtime's
  settings, including whether the rules decide its calls (on by default, PERM-2), and each change
  is audited. The control room MUST offer a new agent the models of the
  default runtime always and those of another runtime only while that runtime can start one; the
  runtimes it offers MUST be readable with their models and efforts. Each runtime's program,
  version, default model and sign-in kind MUST be readable in one place, with no secret value.
- RT-10: A new agent's start MAY name a runtime, a model and an effort. A model alone MUST pick the
  one runtime that offers it, and a start naming neither runs on the default runtime with the
  user's default model. A model no runtime offers, a runtime and model that disagree, and an
  effort the model does not take MUST be refused with the reason, naming the offered models. A
  runtime's models are the ones it reports for the account, else its stable aliases. An agent
  started on a model and effort MUST run every session start, restart and resume on them; a
  fallback switch (RES-14) lasts until the next session start.
- RT-11: Turning a runtime on installs the version the control room pins, in the background;
  pressing Retry and the control room's start while the runtime is on are the only other
  triggers, and the EA and agents can trigger none of them. The install contacts only the host
  the pin names, MUST check the downloaded package's sha512 integrity and then the program's
  sha256, both from the pin, and MUST discard what it fetched and never run it when either
  differs. The program lands alone in a folder of the control room's own data, one folder per
  version, read and run only, which a sandbox mounts read-only. The install resumes a cut
  download, fetches once however often it is asked, and records each install and failure in the
  audit log with the version and checksum. A user MAY name a program of their own instead, for a
  machine without network access; it MUST report the pinned version, and nothing is fetched for
  it.
- RT-12: When an upgrade moves the pin, the control room installs the new version at its start if
  the runtime is on. A running session keeps the program it started with until it ends or
  restarts; a version folder no running program uses, and that the settings no longer need, is
  removed, as is every copy once the runtime is off or runs a program of the user's. Nothing
  outside the control room's own folders is removed.
- RT-14: A runtime whose model can summarise its reasoning MUST ask for the summary, so its agents
  show their thinking as the default runtime's do. Reasoning the model seals for its own next call
  MUST NOT be stored, served or shown by the control room.

## 4. Turn lifecycle

- TURN-1: A user message (`prompt`, `interrupt`, `attachments`, `notify_when_done`, `client_id`)
  MUST start a turn, or queue and join a running turn at its next step; nothing is interrupted or
  discarded.
- TURN-3: `interrupt: true` MUST cancel every queued message, interrupt the turn and send this
  message. A runtime that does not yield within `interrupt_grace` is closed.
- TURN-5: Only the user writes prompts; a delegate's message request MUST be refused (403). A new
  agent's first message written by a delegate MUST carry `from` and be prefixed for the agent with
  `This message comes from <author>, not the user.`
- TURN-7: Slash commands MUST be refused while a turn runs and MUST carry no updates.
- TURN-8: A background report in an open session with no running turn MUST set `running` (`wake`).
- TURN-9: An agent start takes a message and no location: the control room MUST create a fresh
  folder and tell the agent to clone what it needs there. Only the agent moves its working
  directory, to an existing directory inside its own folders (symlinks resolved), from its next
  turn.
- TURN-11: A waiting message MAY be taken back until the agent read it; after that 409.
- TURN-12: Stop takes `queued=remove` (default: drop queued messages, end `stopped`) or `deliver`
  (go on into written messages; updates are still taken back). A stopped turn MUST NOT start a
  turn for waiting updates.
- TURN-14: Retry resends the last real message, with its attachments and `from` mark, as a new
  turn. 409 while a turn runs or when no message exists.
- TURN-15: Session restart keeps the session id and opens the next process at once; it MUST be
  refused while a turn runs unless `interrupt` is set. The reopened process leaves an idle agent
  idle: what a runtime reports on opening is no work until the next input or background work. Rewind restores `conversation`, `code` or
  `both` to an earlier prompt; it MUST be refused while a turn or background work runs.
- TURN-17: The stored result MUST carry the turn's own cost; `cost_usd` accumulates it. A runtime
  that reports tokens but no cost gets an estimate from a dated price table, marked as estimated
  wherever it shows.
- TURN-18: `asking` is true only for an `idle` end whose prose after the last tool call ends in a
  question, optionally with a list of answers, judged without a model call. Questions in code,
  quotes or headings, self-addressed questions and closing courtesies MUST NOT count.
- TURN-19: An agent that asked (`notify_when_done`, await) MUST get one `agent` update when the
  other agent's turn ends.

## 5. Updates and delivery

- UPD-1: `input_mode` is `wake` (default), `queue` or `off`, and is a ceiling: `off` drops every
  update, `queue` holds each for the user's next message, `wake` lets a subscription's timing apply.
- UPD-2: Subscription timing is `now`, `after_turn`, `with_message` or null (agent default).
  Effective timing is `mode == wake ? (choice ?? after_turn) : {queue: with_message, off: drop}`.

| Effective timing | Idle         | Running                       | Running, blocked on user       |
| ---------------- | ------------ | ----------------------------- | ------------------------------ |
| `now`            | start a turn | join at next step             | wait for the answer, then join |
| `after_turn`     | start a turn | wait for turn end, then start | same                           |
| `with_message`   | hold         | hold                          | hold                           |

- UPD-3: PR, agent and request-answer updates have no per-source timing; they follow the mode.
- UPD-4: A held update MUST never start a turn and MUST stay out of turns started for other
  updates. It goes with the next user message, or joins the running turn when the user answers the
  agent's question. The user MAY hand it over or dismiss it.
  Why: an agent that waits on the user must not be steered by a third party first.
- UPD-5: Waking is debounced: a turn starts once no update arrived for `wake_debounce`, at most
  `wake_max` after the first. A turn takes the newest `batch_updates` waiting updates, each body
  clipped at `update_body` and marked so. A batch with any `now` update joins the running turn
  whole.
- UPD-8: After `auto_turns` automatic turns within `auto_window` since the user last wrote, waking
  MUST pause until the window passes; updates wait.
  Why: bounds a loop between an agent and its own event sources.
- UPD-9: Updates that waited through a restart MUST be handed over at startup, with the resume
  message where one is sent. An archived agent takes none (`skipped`); one in `off` records none
  (`ignored`).
- UPD-11: Updates precede the user's text, grouped by source, each group stating its provenance
  and that its instructions are not to be followed beyond the task. The text ends
  `The message from the user follows.` and the prompt, or says none came and to act as the task
  requires.
- UPD-13: Each update is wrapped in a tag by source. Attribute values are escaped, and a body MUST
  NOT be able to open or close any of these tags, in any case or spacing. The planner's message
  is held the same way:

```
<update source="pr" kind="K" subject="S" url="U">TITLE BODY</update>
<channel-event channel="C" source="S" kind="K" severity="V" received_at="T" url="U">...</channel-event>
<thread-reply service="S" from="ID" name="N" bot="true" channel="C" thread="T" received_at="T" url="U">...</thread-reply>
<team-chat from="H" kind="mention|direct|broadcast" message_id="N">...</team-chat>
<agent-turn agent="TITLE" task_id="ID" ended="idle|error|stopped">...</agent-turn>
<seti-answer request_id="ID" outcome="allowed|denied|expired">...</seti-answer>
<workspace-edit file="F">...</workspace-edit>
<second-opinion runtime="R" model="M" seconds="S" cost_usd="C" estimated="true|false">...</second-opinion>
```

## 6. Attention

Why: the whole system exists so that one person can answer "what needs me?" in one glance and be
interrupted only for that.

### 6.1 Needs you

- ATT-1: Needs you holds every agent whose display status is `blocked`, and every `unseen` agent
  whose display status is `error`, `interrupted` or `asking`. A blocked agent stays until the block
  clears; the others leave when the user views them.
- ATT-3: Needs you MUST hold only agents that cannot go on without the user. Failed CI, finished
  turns and proposals that hold no agent MUST NOT enter it.
- ATT-4: `blocked` is the first non-empty of: pending permission request; open questions; pending
  change request; resume hold (RES-8); stall.

| Cause                     | Reason line                                                                        | Clears when                    |
| ------------------------- | ---------------------------------------------------------------------------------- | ------------------------------ |
| Tool call no rule allows  | `Asks to use <tool>: <summary>`                                                    | answered, or the turn stops    |
| Plan approval             | `Asks to approve its plan`                                                         | answered                       |
| Repeat guard              | `Runs the same <call> again after 2 identical results`                             | answered                       |
| Questions                 | `Asks a question: <text>` / `Asks N questions: <first text>`                       | all settled                    |
| Secret question           | `Asks a question: the secret <NAME>, <purpose>`                                    | supplied or dismissed          |
| Change request            | `Asks for <change>`                                                                | answered, or expired           |
| Resume hold               | `Not resumed: restarts cut it off 3 times in 30 minutes before it finished a turn` | any turn starts                |
| Sign-in to a tool server  | names the server                                                                   | sign-in ends, or a turn starts |
| Silence                   | `No output for N min while running`, or the provider error it retries              | output, or turn end            |
| Prose question (`asking`) | `Asked in its reply`                                                               | any turn starts                |

- ATT-5: A turn with no runtime output for `stall_after` is a stall, checked every `stall_check`.
  Time the agent waited on a request to the user MUST NOT count. Every stall MUST surface through Needs
  you; there is no other place an agent waits.

### 6.2 Router

- ATT-7: Every event that could reach the user MUST get exactly one route: `push`, `toast`,
  `call`, `digest` or `passive`. `call` is assigned only when the EA delivers an item by voice on a
  live call.
- ATT-8: Tiers and their surfaces:

| Tier      | Events                                                                                    | Surfaces allowed                | Default |
| --------- | ----------------------------------------------------------------------------------------- | ------------------------------- | ------- |
| `urgent`  | needs-you, failed turn, failed CI, critical alert, mention of or direct message to the EA | `push`, `toast`                 | `push`  |
| `active`  | finished turn of an unwatched agent, reminder, follow-up, alert, model fallback           | `push`, `toast`, `brief`, `off` | `push`  |
| `digest`  | routine news of an agent the EA watches                                                   | same                            | `brief` |
| `passive` | what only informs the EA                                                                  | same                            | `off`   |

- ATT-9: Routing, in order:
  1. A needs-you event is `urgent` whatever its tier.
  2. Surface `off` -> `passive`.
  3. Surface `brief`, or a non-urgent event after `push_cap` pushes within `push_window` of one
     absence -> `digest`.
  4. A page with focus on a device that hears the event (ATT-16) -> `toast`.
  5. Surface `push`, or tier `urgent`, and a push device that hears it -> `push`.
  6. Else `digest`.
- ATT-10: The push count restarts when the user returns. Needs-you is never capped: on surface
  `toast` with no focused page that hears it, it is pushed; only with no push device that hears it
  does it wait for the brief.
- ATT-11: An agent the EA watches or waits for MUST get no push or toast of its own; the EA's
  inbox item, routed by this section, is its one surface. Its turn ended by a stop is routine news
  (`digest`); a turn a restart cut off is `urgent`, and startup reports each one it did not resume.
- ATT-13: Tier surfaces are a notification setting, not a security setting: delegates at full
  reach MAY change them. `urgent` MUST NOT be set below `toast`.

### 6.3 Push

- ATT-14: A push (`finished`, `needs_you`, `ea`) goes out for a turn end, a status that needs the
  user, a new reason line, or agents left interrupted at startup, only to known push service
  hosts over HTTPS. It MUST be skipped when the agent is muted or archived, the state was already
  notified, the EA carries the agent, or the router did not return `push`.
- ATT-16: A device hears about an agent when the event concerns no agent, the device reported no
  workspace, its "Active workspace only" setting (default on) is off, or the agent is in the
  workspace it has open. The mute and the tiers apply first. A device MUST be skipped while its
  page shows the agent or has focus (report at most `focus_ttl` old). Counts the user reads on
  purpose (status bar, app icon, workspace switcher) MUST cover every workspace. A page reports
  its open workspace once when it loads, and after that only when it differs from the one its
  browser last reported: on a switch, or on showing again after another of the browser's pages
  reported a different one.
- ATT-18: Payload: `title`, `body`, `tag` (the agent id; a newer push replaces an older), `url`,
  `kind`, `badge` (Needs you count across workspaces). Body: finished -> `closing_line` or
  `Ended its turn without a reply`; blocked -> reason line; asking -> `Asks: <question>`; error ->
  `Failed: <cause>`; interrupted -> `Cut off by a restart`.
- ATT-21: Re-notify, once each: `ask_remind` after a turn ended on a prose question still
  unanswered (`Still waits: <question>`); when a permission request reaches four fifths of its
  timeout, and no later than 5 min before its end (reason line gains `, times out soon`).

### 6.4 Presence and the brief

- ATT-23: Each visible page reports `{device_id, agents shown, active}` every `focus_report` and
  on focus change. A call is live while the EA polls its inbox as on a call (within `call_ttl`).
  The user is away after `away_after` with no focused page and no live call.
- ATT-25: The first report after an absence builds one brief: up to `brief_needs` agents that need
  the user, with reason lines; then up to `brief_changes` changes (agents whose turn ended since
  the user left, quoting `closing_line`, then inbox items routed `push` or `digest`); then a count
  of the rest. Muted agents, inbox items about them included, and tiers set `off` are left out. A
  waiting brief grows across absences, is held in memory only, and closes on every device when
  dismissed or when a call takes it.

## 7. Trust and permissions

### 7.1 Actors

- ACT-1: Every request has one source: user (local token, session or identity proxy), EA, agent
  (platform tool call), mod (mod API call) or device. The control room MUST derive it from the
  credential or call path, never from a request field.
- ACT-3: Reserved powers. Delegates MUST be refused these with 403 naming who may act, in the
  function that makes the change, not only at the route or tool list:
  - values: reading or setting secret, credential, connection and webhook secret values, and a
    secret question's value;
  - access: credentials, connections, SSH keys and hosts, the allowlist, custom webhook senders
    and sample checks; sandbox policy, an agent's sandbox, `home_access` and tool level;
    unsandboxed starts; an agent's terminal and shell commands;
  - approval: permission rules, the request timeout and bypass; answering permission and change
    requests; publishing or re-enabling shared tools; reviewing knowledge notes;
  - identity: prompts as the user; share links; sign-in, passkeys and devices; installing
    plugins; installing, granting or enabling third-party mods;
  - storage: removing orphans (RES-17); the automatic clean (RES-18); allowing or denying a
    dream's clean-up and emptying the trash (DRM-9, DRM-11);
  - for delegates other than the EA: answering a question (the EA relays); memory and CPU caps
    and compaction; disabling or removing a shared tool, switching the repeat guard, cleaning
    an agent's folders and restoring from the trash (the EA after the user's yes).
- ACT-5: A delegate reaches another agent only through the group chat, which marks the author.
- ACT-6: Agents propose reserved changes with `request_change` (7.6); only the user's own Allow
  applies one.

### 7.2 Sandbox

- SBX-1: Every agent MUST run sandboxed unless the user chose otherwise for it, visibly and
  audited. With the sandbox unavailable an agent MUST fail to start; there is no fallback.
- SBX-2: A sandbox has its own process, network, IPC and host-name namespaces, loopback to its
  egress proxy as its only network, and placeholders instead of credentials. It mounts its own
  folder, platform workspace, a private home, `/tmp` and package caches read-write, and system,
  toolchains, runtime configuration and approved shared tool folders read-only. Other agents'
  folders, credential stores, SSH and cloud configuration, database and cache sockets and the
  control room's data MUST NOT be visible.
- SBX-7: `home_access` adds the user's top-level non-dot home folders read-write, with their
  repository config and hooks read-only.
- SBX-9: Every command the user runs for an agent (shell, terminal, side question, rewind helper)
  MUST run in its sandbox. An unsandboxed agent has the user's access to the host; credentials and
  the allowlist do not apply to it.
- SBX-11: An agent MUST start another sandboxed, at level `self`, with at most its own access and
  approvals no looser than its own (PERM-13); what was withheld is recorded.
- SBX-12: A maintenance session of an agent, such as a dream, runs in a sandbox of its own, with its
  own home, `/tmp` and proxy. It mounts the agent's folders, workspace, package caches and session
  folder read-only, except the agent's own memory folder and the folders the session names; a
  named folder under a hidden path MUST be refused.
- SBX-13: A Codex agent MUST NOT be able to change how its runtime runs commands or asks about
  them. Codex's settings, environment file, sign-in, execution environments, command rules, agent
  roles and user-level instructions, the home's skills, the startup files of its shell in the
  private home and the machine's Codex settings are empty and read-only in its sandbox; every
  other setting and the command search path are passed on Codex's command line, and the approval
  policy with every resume and turn, so stored session state cannot lower it. `AGENTS.md` in its
  folders is input the agent wrote, read as a Claude agent reads `CLAUDE.md`.

### 7.3 Egress

- EGR-1: The proxy allows, in order: the model provider; the agent's connection hosts; cloud
  endpoints when on; SSH first hops of usable hosts; the shared and the agent's allowlist (exact
  host or `*.suffix`, port 443 unless given). It refuses anything else, naming the host, and MUST
  refuse a name that resolves to a loopback or link-local address.
- EGR-4: The proxy terminates TLS only for hosts where it adds a credential, with a local CA
  name-constrained to them whose key stays outside the sandbox. Other hosts are tunnelled unread.
- EGR-5: A placeholder is `seti-secret-<name>-<32 hex>`, in the connection's variable. The proxy
  swaps it for the value in the URL path and headers (Basic auth too), on the connection's hosts
  and port 443 only. A readable request that carries a placeholder elsewhere MUST be refused (403)
  and audited. A connection with no value answers 502. The agent is told where the value is
  swapped and that a body is not.
- EGR-14: On its connections' hosts the proxy reads the body of a JSON, form, multipart or plain
  text request without a content encoding, holding at most 1 MiB, before anything goes upstream;
  every other body streams on unread. A held body carrying a placeholder MUST be refused (403)
  and audited as in EGR-5, naming the connection and never its value, since Seti does not swap a
  value into a body. A body over 1 MiB streams on while the proxy watches the rest; a placeholder
  in it cuts the request off and answers 413. A held body goes upstream with its exact length.
- EGR-7: A header "added by the proxy" is set from its template on every request to the
  connection's hosts, first matching rule winning. The code-host token is the credential's one for
  the owner named, else its default, never another credential's; minted tokens are cached until
  near expiry and renewed on 401. When a rule has no value for a request, the agent's own header
  passes only if the agent's allowlist names the host; otherwise it is dropped.
- EGR-10: Cloud credentials are short-lived, from the credential's role, served by the proxy,
  never the host's own. SSH is off by default; a host is usable only with a login in the
  credential for it and every jump host, with pinned host keys and only those logins' keys.
- EGR-12: Tool servers an agent leaves out MUST be denied to its runtime and get no proxy sign-in.
- EGR-13: A maintenance session's proxy allows the model provider alone, with the agent's model
  login: no connection, allowlist, claude.ai connector, cloud or SSH, and no placeholder is issued.

### 7.4 Permission rules and requests

- PERM-1: A rule (`allow`, `ask`, `deny`, `review`) applies to one agent or all.
- PERM-2: Rules and guards decide first; a classifier then allows or turns down each other call.
  A call it turns down never reaches the user: the agent gets the reason and the audit records it.
  A call an `ask` rule matches, or that nothing decides, becomes a request and the agent blocks.
  On a runtime with no classifier that asks before every call (Codex), guards and deny rules
  refuse at once and review and ask rules hold as for any agent. The rules decide there by
  default: an allow from a rule or the read-only list runs the call, and a call to a tool server
  other than the control room's own runs without the user only by a rule of the user's that names
  that server or tool. The user MAY turn this off for the runtime, and an upgrade MUST keep the
  choice the user stored. Every call that nothing allows becomes a request offering `allow` and
  `deny` only, and a `deny` with a message is refused there since that runtime cannot pass it on.
  Beside each answer the user gives, the implementation counts its own verdict (PERM-12).
- PERM-4: Built-in: reads, search and platform tools are allowed; shell and edits inside the
  agent's folders are allowed in the sandbox only; killing by name is denied.
- PERM-5: Request fields: `id`, `task_id`, `tool_name`, `kind`, `summary`, `input`, `reason`,
  `suggestions`, `editable`, `state`, `created_at`, `timeout_at`, `timed_out`. Decisions:
  `allow` (this call), `always` (adds the suggested allow rules, scope `agent` or `global`),
  `deny` (optional message to the agent).
- PERM-7: Timeout is one install-wide setting: off, 15 min, 1 h (default), 4 h or 24 h from when
  the request was raised. A new value applies to waiting requests.
- PERM-8: At the deadline the request MUST be denied with `timed_out`. The agent is told nobody
  answered, that it is no judgement on the action, and to carry on or ask again. A timeout adds no
  rule and touches no other request. A request whose session is gone closes as `cancelled`.
  Why: an agent must never wait on the user for ever, and must not read silence as refusal.
- PERM-10: Bypass is per agent, off by default, set only by the user for 2, 8 or 24 h, and not
  offered on a runtime without a classifier. In bypass
  the classifier does not apply and a call no rule decides runs without a request; `ask` rules,
  deny rules, guards, review rules, the repeat guard and the sandbox still hold. Turning it off or its expiry MUST take effect at once. Each change
  is audited and noted in the transcript.
- PERM-12: An implementation MAY compute its own decision on each call beside the runtime's, in
  shadow. The shadow MUST NOT change, delay or fail any call, and keeps only counts per day: the
  call's kind and tool, the mode, both outcomes, the deciding step and rule id, never the call's
  input or a rule's text. The user and the EA read them with `GET /permissions/shadow?days=` (1
  to 30, default 7).
- PERM-13: Approval regimes, strictest first: `user` (the user answers every call no guard or rule
  refuses), `rules` (allow rules and the built-in allows run a call, the user answers the rest),
  `classifier` (as `rules`, then a classifier runs or turns down the rest) and `bypass`
  (PERM-10). A Codex agent is `user`, or `rules` while the user lets the rules decide for Codex; a
  Claude agent is `classifier`, or `bypass` while its Bypass lasts. An agent that an agent starts
  MUST settle no call more loosely than its starter: a Claude agent started by a Codex agent, or
  by an agent held so, is held to a Codex agent's regime, which follows that setting, and Bypass
  never passes on. The hold is recorded with what was withheld and in the start's audit, lasts
  for the agent's life and leaves Bypass to the user. A Codex agent or a held one MUST NOT import
  sessions, which would run under the classifier. The user's and the EA's starts are not held:
  the EA has no regime of its own and starts agents only in a turn the user began (EA-8).
- PERM-14: When the user lets the rules decide for a runtime with no classifier, each request of
  that runtime's agents still waiting MUST be decided again as a new call would be: one the rules
  allow runs, one a guard or deny rule refuses is refused with the reason, and the rest keep
  waiting. Only one answer reaches the runtime, the user's or the rules', and it is audited once.
  A request whose turn has stopped is left as it is.

### 7.5 Guards

- GRD-1: Shell guard, every agent, whatever the rules or bypass: recursive delete with a computed
  target or outside the agent's folders; delete through `xargs`; forced clean; output flags to
  paths outside its folders; kill by name or pattern; writes under credential folders. Nested
  scripts (`-c`, `eval`) MUST be checked too. Each refusal is audited.
- GRD-2: Unsandboxed agents also: `find` with exec or delete; search with a preprocessor; opening
  a browser.
- GRD-4: Repeat guard: per thread (agent and each subagent apart), a call identical to the last
  after 2 identical results MUST be held as a `repeat` request before the third run. Calls and
  results are compared by hash, without timings, temporary paths or the call's description; a
  different call or result, or a user message, resets the count. `allow` runs once; `always`
  lifts that exact call for the process; `deny` tells the agent. It asks in bypass too. Only the
  user turns it off; the EA with the user's yes.
  Why: an injected loop costs at most two runs before someone looks.
- GRD-7: A review rule names a tool-server tool or a whole server. Each call it names MUST be held
  as a `review` request, in bypass too, with no `always`. Deny wins over review. If review rules
  cannot be read the call MUST be denied.
- GRD-8: The user MAY edit a held call's top-level text fields before `allow`, only when the
  request shows the input whole and unredacted. The audit records field names, never values.
- GRD-10: Outward: a tool-server call unless its name reads as a read or the tool declares no
  writes; a shell command that pushes, publishes, deploys, mutates a remote API or opens a remote
  shell; any unknown name. Every outward call MUST be audited and counted on the agent.
- GRD-12: Only a tool-server call's input MAY be edited (GRD-8); a shell command never is, so no
  edit passes the shell guard.

### 7.6 Change requests

- CHG-1: Kinds: `allow_host {host, port}`, `api_key {env, hosts[1..5]}`, `mcp_server {server}`,
  `shared_tool` (section 9), each with a `reason` (10 to 500). The answer is
  `{decision: allow, scope: agent | all, value?}` (`value` for `api_key` only) or
  `{decision: deny}`.
- CHG-2: MUST be refused: hosts on the machine or its networks; wildcards over a public suffix;
  `allow_host` and `api_key` from an unsandboxed agent (409). Sandbox, bypass, rules, secret
  values and other agents are never requestable.
- CHG-3: Per agent: one pending request per identical change, at most `chg_pending` pending and
  `chg_hourly` an hour. A request expires after `chg_expiry`.
- CHG-5: Allow applies as the user: the host to the agent's or the shared allowlist; the server on
  for the agent; the connection into the asking agent's credential on those hosts, joining an
  existing one with that variable only on the same hosts and only filling an empty value. The
  agent gets one `seti` update with the outcome and whether a value is set.
- CHG-7: The pasted value MUST travel only in the user's Allow and MUST NOT enter the request, the
  update, the transcript, events, errors or the audit.
- CHG-10: An agent at `self` or `full` is told: when a task needs access it lacks, file
  `request_change` at once and carry on meanwhile; never search memory, transcripts or files for
  how it was done before.
- CHG-11: While MCP servers are off for an agent, its prompt lists them: `mcp_off_listed` by exact
  name, each with up to three words taken from its tool names, and the rest as a count. The list
  MUST carry only names and tool-name words, MUST count rather than show a name with characters
  beyond letters, digits, space and `_ . : @ -`, and is absent when no server is off. An
  `mcp_server` request matches a name whatever its case and is stored under the exact name.
- CHG-12: The update of an allowed or denied request is handed over without `wake_debounce`
  (UPD-5); a running turn still ends first. The turn that brings an allowed server starts a new
  session that has it once no background work holds the old one, and the update names the
  server's tool prefix and up to five of its tools.

### 7.7 Hostile repositories

- HST-1: Everything in an agent's folder is input the agent wrote and MUST NOT run code on the
  host. Code-host text (titles, branches, checks, comments) is rendered as text and reaches agents
  only as an update or tool result.
- HST-2: The control room runs version control in an agent-writable folder only with hooks,
  filters, external commands, helpers and transports disabled, ignoring system and user config. A
  repository pointer file is followed only when the repository records that folder.
- HST-4: The capability probe of a sandboxed agent's folder MUST run in its sandbox; any other
  agent-writable folder is probed with the user's settings only.
  Why: project settings start hooks and tool-server commands.
- HST-5: Sandboxed agents' file tools MUST NOT edit runtime settings, hooks or tool-server config
  in any folder; unsandboxed agents are asked. An HTML file an agent wrote MUST render only in an
  opaque-origin frame with no network and no script by default.
- HST-8: A tool-server sign-in runs on the host only when the user starts it, starts no hook or
  server command, and MUST refuse a project server the user has not approved.
- HST-9: The control room serves an agent's files only inside its folders and workspace and, for a
  sandboxed agent, its private home and `/tmp`, symlinks resolved; hidden paths, the home's logins
  and the runtime's and control room's data are refused. The workspace and the sandbox roots are
  read-only. The user MAY save text naming the content it replaces; delegates only read, and the
  EA never key or env files.
- HST-10: Attachments are staged outside every sandbox and land in the agent's workspace under a
  new name; a link planted at the target is replaced, never followed.

### 7.8 Resource caps

- CAP-1: Each agent's process tree runs under a memory cap (`mem_cap`) and a CPU quota (`cpu_cap`)
  below the control room's scheduling weight; the agent MUST be told its memory cap and cores.
- CAP-2: At the memory cap the largest tool process MUST be stopped before the runtime; the rest
  continues. Each kill MUST become one transcript note naming what was stopped; if the runtime
  died the turn ends.
- CAP-5: A cap change reaches running agents at once. Agent processes MUST NOT outlive the control
  room that started them.

## 8. Secrets and connections

- SEC-1: A credential bundles code-host tokens (default and per owner), a cloud role, SSH hosts and
  connections; one built-in default exists. Credentials apply to sandboxed agents only. A new
  connection is in no credential until switched on per credential.
- SEC-2: Connection: `name`, `kind` (`key`, or the minting `client_credentials`,
  `refresh_token`, `jwt_bearer`), `env`, `hosts` (at most 20), `header {name, template}`, mint
  settings, value slots (set or unset only). `env` MUST NOT be a variable the control room or
  runtime sets; hosts MUST NOT cover the model provider or the code host.
- SEC-5: Values are write-only (reads give status only), sealed with AES-256-GCM, a random 12-byte
  IV and the secret's name as associated data. The key is a file outside the database and backups.
- SEC-8: A value MUST NOT appear in logs, transcripts, audit, events, errors, chat, the EA's
  context, a mod's input or output, or any API response. Text stored or shown from agents MUST
  pass credential redaction.
- SEC-10: A free-text user answer that looks like a credential MUST be refused (422), with nothing
  in its batch stored.
- SEC-11: Any agent MAY call `ask_secret {name, purpose, hosts}`. Only the user sends the value,
  alone, on its own route. Sandboxed, it is sealed as a connection for those hosts in the agent's
  credential; unsandboxed, it is a 0600 file in the agent's workspace that no view, handoff, share
  or archive serves. The call returns where it went, never the value. The question expires when
  its call is cancelled, its session closes or the control room restarts; later values are kept
  nowhere.
- SEC-14: Webhook secrets and tokens are sealed. Only the user pastes one an app issued, or reveals
  one the control room made, once.

## 9. Shared tools

- TOOL-1: A shared tool is one script an agent proposed and the user allowed for every agent. Only
  the user publishes or re-enables one; the EA MAY disable or remove one after the user's yes;
  agents MAY only list them.
- TOOL-2: A proposal (`name`, `description`, `path`, `input` as a bounded JSON Schema, `writes`,
  `timeout_seconds`, `needs {env, hosts}`) names one regular UTF-8 file in the agent's folders, no
  symlink, that the control room reads itself (`tool_schema`, `tool_script`).
- TOOL-5: Definition and script are stored under one SHA-256; the card shows the whole script, or
  its difference from the published version, and Allow publishes exactly that snapshot. A
  proposal against a replaced version MUST be refused.
  Why: what the user read is what every agent runs.
- TOOL-7: Publishing grants no key or host: a tool loads as `mcp__shared__<name>` only while on,
  for an agent whose credential covers every `needs` variable on its hosts.
- TOOL-10: A call checks arguments against the schema and runs the script with no shell, arguments
  as one JSON object on stdin, stdout (`tool_output`) as the result and a non-zero exit as an
  error; at the time limit the process group is stopped. It runs where the caller runs, unasked in
  the sandbox and asked outside it unless a rule allows it.

## 10. Inbound events

- CHN-1: Webhooks, pollers and reminders feed one event path. An event has `severity` (`info`,
  `success`, `warning`, `critical`), `title`, `detail`, `url`, `kind`, `subject`, `state` (`down`,
  `up`, null), `dedupe_key` and `occurred_at`, redacted. It is unique per channel and
  `dedupe_key`; per subject a repeated state is a duplicate and a first `up` a baseline.
- CHN-6: Webhooks take `POST /hooks/<id>` (18 random bytes, URL-safe); anything else is 404.
  Answers: 200 `{status: accepted | duplicate | ignored | filtered, reason}`, 400, 401, 413, 415,
  429 with
  `Retry-After`, 503.
- CHN-7: A delivery MUST prove the channel's secret, compared in constant time, before any parser
  reads it. The sender is a mod's (it names the header; 503 while the mod is off), the control
  room's own (hex HMAC-SHA256 of the raw body in `X-Seti-Signature`, or the secret as a bearer
  token), or a definition (CHN-31). A refusal is 401, logged without the body. A delivery id (the
  sender's, else a body hash) is taken once per channel within `hook_replay`; size and rates are
  capped (`hook_limits`), the overall rate before the channel lookup.
- CHN-31: A sender definition, from a catalog of named apps or written by the user, is data with no
  code: a header; a shared `token`, or an HMAC (`sha256`, `sha1`, `sha512`; `hex`, `base64`;
  prefix; separator; key as text or base64 bytes) over `{body}`, `{timestamp}.{body}`,
  `v0:{timestamp}:{body}` or `{id}.{timestamp}.{body}`; where timestamp and id are; dot paths for
  event, title, link and detail. A timestamp beyond `max_age_s`, past or future, MUST be refused.
  A URL check is answered only after the signature verifies, with one string field of it, at most
  256 characters, as text.
- CHN-32: A webhook MAY have a filter, a JavaScript module whose default export (possibly async)
  gets `{event, action, title, link, detail, headers, payload}` after verification and parsing and
  before any subscriber. `headers` is an allowlist of headers naming the event, never one about
  authorization, signatures, tokens or cookies. It returns `false` or `null` to drop the delivery
  (`filtered`, no event stored), `true` to keep it, or an object replacing any of `event`, `title`,
  `link` (http or https) and `detail` with strings. It runs with no network, files, timers or
  processes (`filter_limits`). A throw, timeout or any other return keeps the delivery unchanged;
  the log says `filter failed` with the error, never the payload, and `filter_warn` failures in a
  row warn on the webhook. Each delivery logs what the filter did, and each webhook counts kept,
  changed, dropped and failed deliveries for 24 hours. A test runs code against the newest
  `filter_samples` deliveries and a pasted request and stores and sends nothing. Delegates write a
  filter as they write a poller script without secrets (CHN-19); approval and the tools show its
  code in full, and the audit records its hash.
- CHN-19: Only the user gives a poller extra hosts or secrets, edits a poller that sends secrets,
  writes a custom sender, supplies a webhook secret, or checks a sample. Delegates MAY create a
  webhook for a catalog sender; it refuses deliveries until the user supplies the secret.
- CHN-12: A poller runs on an interval in an engine with no files, environment, timers or
  processes (`poller_limits`). It gets `fetch`, `parseFeed`, `log`, `state` and `since`, and
  returns items `{key, title?, kind?, url?, body?, fields?, fingerprint?}`, optionally with
  `state`. `fetch` reaches only allowlisted and the poller's own extra hosts on public addresses,
  and its secrets read `[secret]` in all the script sees.
- CHN-17: A poller's first good run is a baseline; then new, changed and (with gone detection)
  missing keys become `<kind>`, `<kind>.changed` and `<kind>.gone`. Failures double the interval
  up to `poller_backoff`; `fail_streak` failures report `poller_failed` or `reminder_failed` once,
  and the next success `poller_recovered` or `reminder_recovered`.
- CHN-20: A reminder runs on an interval or a cron schedule in a named timezone, in a fresh process
  with no network, environment, children or files (`reminder_limits`), and returns a message or
  nothing. Due runs are claimed atomically, so none fires twice; a missed interval runs once and a
  cron runs only its newest missed slot within `cron_catchup`.
- CHN-25: A subscription links a channel to the EA or one agent, with `events` (empty is all; an
  entry matches its kind and `<entry>.` prefixes), the EA's `mode` (`report`, `act`) and the
  agent's `delivery` (UPD-2). An agent at `self` subscribes only itself; none subscribes the EA.
  An agent gets a `channel` update; the EA an inbox item, urgent when `critical`, or `down` with
  `warning`.
- CHN-29: Each delivery is logged with its status, HTTP status, reason, a redacted excerpt and
  each subscription's outcome. Failed routes retry with doubling backoff (`route_retry`).
- CHN-33: Seti learns Slack channel and person names only from what passes through it: markup and
  profiles in verified Slack deliveries, and the results of agents' Slack MCP calls. A different
  name for an id replaces the old one. Where Seti shows a Slack id (a Slack event's title and text,
  a thread reply, a Slack send's request summary, transcript row and audit summary) it shows the
  name it knows, else the id and "name not known"; it never guesses. Audit details keep the ids.
- THR-1: A Slack message an agent sends, with an MCP `send_message` tool or `chat.postMessage`, is
  recorded when its successful result names the channel and ts (a Slack message link, or the Web
  API answer). Its thread is the link's or the call's `thread_ts`, else the message itself, and
  the agent follows it; a later send there follows it again after a stop. Seti keeps ids and the
  link, never the text. An agent follows at most `thread_cap` threads; a new one stops the least
  recently active.
- THR-2: A webhook whose sender Seti reads threads from (the catalog `slack` sender) hands each
  verified message event to the thread matcher before its filter. A new message (not an edit,
  deletion or join) in a followed thread is queued for every agent following it whose first message
  there is older, once each, when the webhook's `thread_replies` is on. With `thread_dms` on, an
  unthreaded message in a direct message goes to the agent that wrote there last within
  `dm_window`. A message any agent sent is never queued. Queued text is redacted.
- THR-3: A message event of such a sender reaches subscribers only when the webhook's filter keeps
  or changes it; otherwise the delivery is `ignored` and keeps no excerpt.
  Why: a user who subscribes the app to message events for replies must not flood the EA's inbox.
- THR-4: A queued reply is routed after `reply_settle`, so an agent's own message whose echo came
  first is recognised (`own`). It reaches the agent as a `thread` update unless the thread is
  stopped or `thread_rate` replies of it were sent within the hour (`rate`). A bot's reply is held
  for the user's next message (UPD-4). An archived agent gets nothing and the thread stops. Once
  routed, the reply's text is forgotten; the audit keeps ids, author, size and outcome.
- THR-5: Following stops after `thread_quiet` without a message in the thread, or `thread_age`
  after it started.
- THR-6: Only the user turns `thread_replies` and `thread_dms` on or off; both start off. Turning
  `thread_replies` on turns `thread_dms` on too unless the same change says otherwise.

## 11. Pull requests

- PR-1: The PR set is every open PR the host's code-host login wrote, in any repository, and every
  open PR linked to an agent; no repository list is needed. Reads use that login, never a
  credential's tokens.
- PR-2: Links come from the agent's create call (every PR URL in its result), transcript evidence
  that it opened the PR or pushed its head branch, the user, or a create request. A dismissed link
  MUST never be relinked automatically. A merged or closed PR is unlinked after its last update.
- PR-4: PRs linked to an agent that takes updates, or watched by the EA, are polled every
  `pr_poll`; the first sighting is a baseline. Each change is one `pr` update to every linked
  agent, except three kinds recorded quiet, which never wake an agent or count as waiting.

| Mark                       | When                                                                                                              | Agent gets          |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------- |
| `not sent: own action`     | the agent posted the comment or review, or merged or closed the PR                                                | nothing             |
| `not sent: repeat`         | checks reran on a commit and ended as reported before                                                             | nothing             |
| `no wake: nothing pending` | CI passed, the last reported result was no failure, and the agent pushed or opened no PR since its last CI update | the pass, next turn |

Why: an agent woken by its own actions or by news nobody waited for burns turns and attention.

- PR-6: Own action comes from the agent's tool calls, not the author: an exact id in a posting
  call's output, else the host login posting on that PR during the call (`pr_skew`), or a merge
  or close call at the PR's end time. Anything not tied to a call is delivered.
- PR-8: A failure is reported once per head commit, again only for checks not failed on it before;
  a conflict once per head commit and base branch until the PR merges cleanly again.
- PR-9: Updates for a PR linked to a running subagent wait for it (`subagent_wait`) and go to its
  parent.
- PR-10: `ci` rolls up as `failure` over `pending` over `success`, else `neutral`, superseded runs
  dropped. `review_decision` and `mergeable` take the code host's values.
- PR-12: Fix CI sends each agent with failing CI on a linked open PR, unless archived or stopped,
  one message naming only its PRs: `CI is failing on <refs>. Please fix it|them.`

## 12. Group chat

- CHAT-1: One chat joins the user, the EA and every agent; agents have handles from their titles,
  and `all`, `active`, `ea` and `user` are reserved.
- CHAT-3: A mention reaches that agent; `@all` or an EA post every active agent. An idle agent
  starts a turn; a running one takes a user or EA mention now and others at its next step. Agent
  traffic is held past `chat_burst` deliveries to one agent and `chat_loop` exchanges between two.
  Muted agents skip mentions.
- CHAT-6: Only author, recipient and user see a direct message; others read
  `[direct message hidden]`, and the audit keeps sender, recipient and length only.
- CHAT-8: Agents MAY post by appending to a chat file in their workspace, first line
  `direct @handle` or `public`. While the last message is direct, an unmarked append MUST be
  refused.
  Why: a private answer must not land in public by default.
- CHAT-9: A side question forks the session read-only, without tool servers, and writes nothing
  back.
- CHAT-10: A side question MUST be refused when the agent's session holds a direct message the
  asker may not see (CHAT-6).
- CHAT-11: A direct message to a muted agent waits for its next turn; it is not skipped.
- CHAT-12: `@active` is a mention of every unarchived agent but the author that runs, or was
  created, ran or ended a turn since local midnight in the user's stored timezone, else the
  host's. The agents it reached are stored with the message and never re-resolved; none is valid.

## 13. Agent-to-platform tools

- LVL-1: Each agent has a level, `off`, `self` (default) or `full`, that only the user changes.
  Tools run in the control room as that agent, with no token in the sandbox, audited by agent.

| Level  | Tools                                                                                                                                                                                |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `off`  | own status line; own working directory; file handoff; `ask_secret`                                                                                                                   |
| `self` | + `request_change`; knowledge propose, search, verify; read platform state; change only itself (title, colour, pin, update mode, PR links, context, role, handle, own subscriptions) |
| `full` | + every action the EA has, on any agent                                                                                                                                              |

- LVL-3: The level MUST be checked on every call, not only in the tool list.
- LVL-4: At `self`, tools take no argument naming an agent; the caller is filled in. A reference to
  another agent is refused without revealing which agents exist.
- LVL-5: At `full` an agent MUST NOT stop, archive, delete, rewind, restart or retry itself.
- LVL-6: Parity: every platform action that is not a reserved power MUST exist for the EA and at
  `full`, exceptions listed on each side. No tool on either side may approve, allow, bypass, share
  or publish.
- LVL-8: An agent asks with the runtime's question tool: 1 to 4 questions a call, each with 1 to 8
  options, held until all are answered or dismissed. A choice is single or multiple; `yes_no` has
  exactly yes and no; both take free text instead. A recommended option is first and its label
  ends `(Recommended)`.
- LVL-10: Answers arrive as one batch,
  `{items: [{action: answer, id, selected, other} | {action: dismiss, id}]}`, all validated before
  any is stored; questions closed meanwhile are skipped. The agent gets its input plus `answers`
  keyed by question text. A dismissal says so; a group only dismissed is a denial telling it to use
  its judgement. A stopped turn or ended session expires the group.
- LVL-13: Every agent is told: no go-ahead questions on reversible work in scope; take and name a
  clear recommendation; ask only when a choice is irreversible, outward, changes scope or is
  balanced; never end a turn on a prose question; ask for secrets only with `ask_secret`. Every
  agent and, by the subagent start hook, every subagent gets the house rules: no foreground sleep
  or polling; stop processes by exact PID; recursive delete only on literal paths in own folders;
  tool names are case sensitive.
- LVL-15: Agents at `self` or `full` propose knowledge notes, at most `notes_waiting` each, refused
  with credentials or private paths. Only a bounded index of approved titles reaches prompts,
  framed as reference, not instructions. Notes go stale by `note_stale`.
- DLG-5: An agent at `self` or `full` MAY ask a model on another runtime one question, with text
  and up to `opinion_files` of its own files read under the file hand-off rules. The answering
  model MUST be offered no tool and refuse any call unasked, run in a sandbox of its own that
  mounts none of the agent's folders, reach only its provider, with the asking agent's
  credential, and keep no session. With no runtime named, the first runtime in offer order that
  is not the caller's and can answer for its credential answers, with its first model. What is
  sent MUST be redacted and bounded by `opinion_sizes`, and MUST NOT quote a direct message the
  agent can read. It is refused with the reason while no such runtime is ready, while the sandbox
  is off, while the agent has one running, and past `opinion_rate`. The answer reaches the agent
  as its tool result in a `<second-opinion>` tag (UPD-13) with a preface that it is data. The
  cost is the caller's, marked estimated where the runtime reports none; the audit records the
  runtime, model, sizes, cost and outcome, never the text.

## 14. The assistant

- EA-1: The EA is a separate process with its own token, acting only through the user's API; every
  change is audited as the user's with `via: ea`. It MUST NOT hold reserved powers and has no
  code-host write tool (merge, approve, comment, push).
- EA-3: A changing tool first records an ask (tool, arguments, summary, change key) and does
  nothing; the same change asked again returns the open ask. Only the user's yes runs it.
- EA-4: A yes counts only for an ask from an earlier user turn or EA process, within `ask_ttl`. One
  ask takes one answer and runs once with the recorded arguments. The user MAY answer by text,
  voice or notification; delegates MUST NOT.
  Why: the model cannot ask and approve in the same breath.
- EA-7: The EA reaches agents only by group chat. A direct message joins a running turn or starts
  one; it never interrupts.
- EA-8: Inbox items are `followup`, `reminder`, `watch_event`, `channel_event`, `team_mention`; a
  new event for an undelivered item's subject replaces it. Unasked reports get read tools only,
  except that one made only of `act` subscription items MAY direct-message an existing agent and
  MUST tell the user.
- EA-10: Off a call, watch and channel items wait for quiet (`settle`); others go at once. On a
  call nothing interrupts: items follow the user's next turn, and a needs-you item gets its own
  line after `call_silence`.
- EA-12: If a reply promised to reach an agent and no tool did, the EA gets one more run.

## 15. Resilience

- RES-1: On a stop signal the control room MUST, within `stop_grace`, record each running turn
  (kind, background count), audit the stop and interrupt each turn so its session is saved.
  Agents stay `running` in the store; questions and permission requests stay open.
- RES-3: At startup every agent still `running` is marked `interrupted` and `unseen`; after a crash
  its turn kind is treated as `user`.
- RES-4: With resume on (default) each cut agent gets one control-room message, plus a note when
  background work was stopped, in the order `user`, `wake`, `updates`, paced by `resume_pace`:
  `Seti restarted while you were working. Continue where you left off; check the state of anything you had running before repeating it.`
- RES-6: Not resumed: archived agents, agents waiting on a question or permission request, agents
  the user messaged first, and all when resume is off; those not waiting are notified. A waiting
  agent keeps its requests and reason line, and the answer resumes it. A cut request cannot be
  edited and still times out from when it was raised.
- RES-8: Loop guard: after 3 resumes in 30 min with no finished turn, the agent stays `interrupted`
  with the resume-hold reason, audited. A turn ending `idle` resets the count.
- RES-9: Allowing a tool call after a restart allows only that call: the next identical call
  within `grant_ttl` runs once without a new request.
- RES-10: Lost by a restart, by design: messages queued behind the cut turn (marked removed),
  background commands and subagents, in-memory stalls, the brief.
- RES-11: A `client_id` (UUID) on a message, start, chat post or EA chat makes a repeat within
  `send_window` take effect once and return the first result.
- RES-12: All work on one agent is serialised. Work that must survive restarts (reminders, EA
  follow-ups, asks, inbox) lives in the store, not in timers.
- RES-14: A fallback model switch is audited once, stored on the agent and routed `active`;
  switching back sends only the original model's command, after the turn.
- RES-15: Archive packs the agent's folders and transcript; restore puts them back; delete removes
  them, without a shell, and only a real directory one level below an owned root that no other
  agent uses.
- RES-16: Clean removes only rebuildable folders (dependencies, virtualenvs, caches by name; build
  output only where its repository ignores it) inside folders the control room made for one agent,
  and only those both its preview and the confirm name. It MUST NOT remove a folder version control
  tracks files in, reach through a symlink, or run while the agent runs a turn or background work.
  Every removal, by Clean or of an orphan, is audited with its path and the bytes freed, never
  file contents.
- RES-17: An orphan is a folder in a control-room root that no agent, live or archived, owns, or a
  worktree record whose folder is gone. One that changed within `orphan_grace`, is in use, or holds
  uncommitted changes or unpushed commits MUST NOT be removed; it is listed with the reason.
- RES-18: The automatic clean is off by default. When on, it cleans agents idle past 7, 14 or 30
  days and archived agents, never a running one, and records what it freed.
- RES-19: Sizes are measured in the background within `size_walk`; a read MUST NOT wait for a walk,
  and a walk cut short reports its size as a floor.

### 15.1 A separate node

Optional and off by default: sessions run in a node process and the control plane keeps the
store, the audit chain and every record.

- NODE-1: The two talk only over a WebSocket on a unix socket in a folder only the control room's
  user may enter. The control plane MUST refuse a socket or folder another user owns or could
  reach. Nothing listens on TCP.
- NODE-2: The node numbers each agent's journal entries and keeps them until acknowledged. The
  control plane applies each entry at most once and in order, keeping its cursor before it
  applies, so a dropped link or a restart of either side neither repeats nor reorders one. A
  cursor it cannot keep stops it applying, with an error, until a restart takes up from there.
- NODE-3: An ask carries an id the node made; a repeat gets the first answer, and an ask the
  node stops waiting for aborts the answer in progress. A request the user answers takes the
  ask's id, so an ask the node still waits on when a control plane starts keeps its one request,
  and the user's answer reaches the call once. The prompt row of a message going out is stored
  with its ask's id in one transaction, so the same ask after a restart gets that row back.
- NODE-4: A restart of the control plane MUST NOT cut running turns, and the tool calls they have
  open show as open again. A node that started anew says so as it connects, and the turns of the
  node before count as cut by a restart (RES-3 to RES-8).
- NODE-5: A stopping node first has the control plane record and audit its running turns
  (RES-1), then cuts them and waits until its entries are stored.
- NODE-6: The answer to a command about an agent is read only once the control plane applied
  every entry the node reported for that agent before answering, so what the command changed
  shows at once, as it does in one process.
- NODE-7: The node reports the scopes it started and their memory events, and moves them to a
  changed cap; the processes view and the resources page show the agents' processes under
  either process.
- NODE-8: Only the node runs agents' egress proxies. A sandbox the control plane builds, for a
  terminal or a `!` command, has the node open the agent's proxy and uses it, and removing an
  agent stops its proxy on the node. The proxy applies a grant the control plane hands it with no
  value in it (the agent's connections, MCP sign-ins, denied connectors, login and CA hosts), and
  asks the control plane for the allowed hosts, ssh first hops and AWS switch when it checks them.
- NODE-9: A command the node's guard refused, and a request its egress proxy blocked for
  carrying a connection's placeholder toward a host the connection does not allow, reach the
  control plane as journal entries, which it audits once.
- NODE-10: The node's egress proxy asks the control plane for each Claude, GitHub, claude.ai
  connector, MCP sign-in, connection and AWS value it puts on a request, and the node's ssh agents
  ask for their keys on each load; the node keeps none between requests. A changed or removed
  connection therefore applies to the next request, with no delay, and a changed ssh key or host
  reloads the node's ssh agents. A sandbox the control plane builds gets the AWS token of the
  node's proxy. While the control plane restarts, a request that needs a value, or the agent's
  allowed hosts, ssh hops or AWS switch, waits for it up to 30 seconds; after that the proxy
  answers 503, which clients retry.
- NODE-11: Values cross only to a node on the same machine, over the owner-only socket of NODE-1;
  the control plane refuses every ask and command that carries values on any other link, so a
  node on another machine needs a sealed path. No error, log or frame dump names a value, and the
  control plane keeps no answer that carries one once it is sent.
- NODE-12: The node owns each agent's ssh agent and the sandbox CA files as it owns the proxy: a
  sandbox the control plane builds has the node start the ssh agent, and only the node loads and
  writes the CA.
- NODE-13: The node starts an agent's process from the spec and a launch plan the control plane
  hands it with no value in it: the caps, and for a sandboxed agent its policy, read-only folders,
  proxy grant, MCP choices, ssh files and switches. A sandbox the control plane builds uses the
  same plan.
- NODE-14: The node never loads the secret store, so it runs without the store key; every value it
  uses reaches it as NODE-10 says.

### 15.2 Dreams

Optional and off by default: a maintenance session per agent that consolidates its memory.

- DRM-1: Nightly Dreaming is off by default. Its settings: on, a window (local start and end), an
  IANA zone saved explicitly, a model, a budget per dream and per night, and dreams at once (1 to
  3). Turning it on needs a zone. Each agent and each workspace has a switch, default on. The
  settings are the user's and the EA's after the user's yes; agents and mods MUST be refused,
  since the settings hold the caps every dream runs under. An agent below `full` changes no
  switch, and no agent switches itself. Every change is audited with its old and new values.
- DRM-2: A night is the local date its window starts on, in the saved zone. A start or end the
  clock skips moves to the next valid minute; one it repeats takes the first occurrence. An end at
  or before the start ends on the next day.
- DRM-3: At the window's start, or at the first tick inside it, the night is planned once: one
  dream for each unarchived agent switched in with its workspace, sandboxed, whose runtime
  declares dreams and that had a user message or a turn with tool calls since its last finished
  dream, the busiest first. Agents left out are counted by reason. An agent dreams at most once a
  night by the schedule. While Dreaming is on for an agent, its runtime's own memory
  consolidation is turned off in its sessions, so one consolidator owns the folder.
- DRM-4: A dream starts only while the agent is unarchived and sandboxed, its runtime declares
  dreams, it runs no turn or background work, holds no open question, permission or change
  request, has no dream running, and the runtime's own consolidation did not run in the last hour;
  otherwise it is refused with the reason. A nightly dream refused for work or an open request is
  tried again every `dream_retry` until the window ends, then skipped with its last reason. None
  starts after the end; one running at the end is stopped.
- DRM-5: Nightly starts are at most the setting at once and `dream_gap` apart, and wait while plan
  use, host load or free disk on the root disk and on Seti's data disk is past `dream_gates`, or
  while the night's spend leaves less than one dream's budget. Turning Dreaming off ends the
  night: running dreams stop and planned ones are skipped. A night Seti was down for is recorded
  once as missed and is not caught up.
- DRM-6: A dream is a new session of the agent's runtime that resumes nothing (RT-8), in the
  agent's maintenance sandbox (SBX-12) with egress to the model provider only (EGR-13), writable
  only in its memory folder and the night's dream folder of its workspace. It reads a digest of
  the agent's transcript since its last dream, built from neutral events, at most
  `dream_digest` characters, with credentials redacted and the user's messages and failures kept
  first.
- DRM-7: A dream MUST NOT start or change a turn of the agent, post, send an update, push or
  notify, or enter Needs you. Its outcome is one stored report, also written beside the digest,
  and the agent's next turn is told once which dreams changed its memory.
  Why: the agent's conversation is the user's.
- DRM-8: Every memory file a dream changes is recorded as a revision with its text before and
  after, credentials redacted. The user, and the EA after the user's yes, MAY revert it; a revert
  of a file changed since, or of a text kept only redacted, MUST be refused (409). Every change
  and revert is audited with the path and line counts, never the text. The last dream's report
  shows each changed file's diff, from that stored text, with its revert beside it.
- DRM-9: Clean-ups are off by default and a setting. When on, a dream MAY propose a clean-up
  (`trash`, `remove_worktree`, `delete_branch`) with a reason, at most `dream_proposals` a dream.
  The control room checks it when filed and again when the user allows it, and applies it only
  on the user's own Allow: the EA, agents and mods MUST be refused. An applied clean-up moves the
  target into the trash; a branch is deleted with its tip kept. A proposal not answered in
  `proposal_expiry` expires. Proposals hold no agent and never enter Needs you.
- DRM-10: A proposal MUST be refused for: a path that is not plain or goes through a symlink; a
  path outside the agent's folders, or the folder itself; the workspace's Seti files, uploads,
  inbox, secrets and dreams; files git tracks; untracked files git does not ignore; ignored files
  other than rebuildable output; a worktree with changes, untracked files or unpushed commits,
  or a repository with stashes; a branch not merged into the remote's default branch or checked
  out; anything another agent uses; anything over `trash_item_max`. Allow is refused with 409
  while the agent runs a turn or background work or a process works in the target.
- DRM-11: The trash keeps an item for `trash_keep`, then removes it. Restore puts it back if its
  path is free (else 409); a branch is recreated at its tip. Every move into the trash, restore
  and removal is audited with path and bytes, never content.
- DRM-12: A turn of the agent that starts during its dream cuts the dream. A restart cuts it too;
  the memory changes it made before the cut are still recorded. A cut nightly dream is planned
  once more within its window; cut again, it has failed.
- DRM-13: A dream stops at its budget per dream (`dream_budget` by default), `dream_steps` or
  `dream_time`, and runs on the model the settings name. Its cost is stored on the dream, not on
  the agent's turns.
- DRM-14: The first brief after a night's window holds one line for the night: agents dreamt, how
  many want the user, the cost. It never counts toward Needs you, and nothing about dreams
  notifies at night.
- DRM-15: Text a dream reads is data. A memory write that carries a credential, a hidden file or a
  file that is not text MUST be refused, and so MUST every tool call the gate does not allow.
  Added memory lines that name a new host, pipe into an interpreter or read as commands are listed
  in the report as Seti's own findings.
- DRM-16: Dream now runs one dream of an agent at once, by the user, the EA after the user's yes,
  or an agent at `full` on another agent; it is refused on the agent itself. The EA, an agent or
  a mod starts at most one dream of an agent a day; only the user starts more. Dream now waits for
  no window but keeps the night budget. The start is audited with who asked for it.

## 16. Audit

- AUD-1: Every change by the user, a delegate or the control room MUST be audited. A failed audit
  write MUST NOT fail the action.
- AUD-2: Record: `id`, `at`, `actor` (`user`, `agent`, `system`, `mod:<id>`), `kind`
  (`<area>.<name>`; a mod's own `mod.<id>.<kind>`, declared), `subject_type`, `subject_id`,
  `summary`, `detail`. An EA action is `user` with `detail.via = ea`; sessions, identity proxies,
  devices and unauthenticated requests are marked in `via` likewise.
- AUD-5: `hash = SHA-256(JSON([id, at, actor, kind, subject_type, subject_id, summary, detail, prev_hash]))`.
  The first event links to 64 zeros. Appends are serialised under a lock on the head.
- AUD-7: Verification walks from the anchor to the head and reports the first event whose link or
  hash fails, as `{ok, checked, head_id, head_hash, broken_at, problem}`. Pruning after
  `audit_keep` moves the anchor to the last pruned hash.
- AUD-8: The head MUST be written daily to a log the control room's user cannot rewrite.
- AUD-10: MUST NOT appear in a record: secret or connection values; attached file content; direct
  message text; free-text answers (length only); side-question text; mod command arguments and
  edited field values (names only); typed terminal input. Text is bounded and redacted.
- AUD-12: Also audited: outward calls; classifier refusals; guard refusals; refused sign-ins (rate
  limited); placeholder misuse; each restart cut, resume and hold.

### 16.1 Settings document

- CFG-1: The control room MUST offer its stored settings as one JSON document with a `version`, a
  `revision` and a JSON Schema derived from the schemas that validate its settings writes. Its
  sections follow the settings groups and pages the user sees; lists are keyed by a stable name.
- CFG-2: The document, its schema and any error about it MUST NOT contain a secret value; a secret
  reads `set` or `not set`.
- CFG-3: Agents, mods and devices MUST be refused the document and its schema. The EA reads plain
  configuration only; security settings are absent from its document and schema.

## 17. Mods

- MOD-1: Tiers are `theme` (tokens only), `bundled` and `third-party`. A mod's manifest (id,
  version, API range, capabilities, contributions, `securitySensitive`, `required`) is read
  before any code runs; one that is invalid or unmet keeps the mod off with a reason.
- MOD-3: All a mod adds is named `<mod>.<name>`, each key taken once. Turning a mod off MUST
  dispose all it registered and MUST NOT drop its settings or data.
- MOD-6: A mod is its own source (ACT-1). No mod runs programs, reads beyond a grant, sees a
  secret, holds a reserved power, writes as the user, manages mods or runs another mod's command.
  Each operation is checked against grant, scope and a strict schema; an agent outside a filter
  does not exist to it. Third-party text reaches agents only labelled as the mod's.
- MOD-8: Capabilities, each scoped: `tasks.read`, `tasks.manage`, `chat.post`, `files.read`,
  `net.fetch` (named public hosts), `connection` (a value the control room adds and redacts),
  `storage`, `notify`, `agents.context`; bundled only `seti.version`, `workspaces.layout`,
  `tasks.ask`, `tasks.dream` (reads nights, whether Dreaming is on or has run, and waiting
  clean-ups, and starts a dream as the mod,
  under DRM-16; it never answers a clean-up). A mod's start or stop only records an ask for the user; an agent so started is
  sandboxed at `self` with the default credential and its first message marked as the mod's.
- MOD-12: Third-party logic runs outside the control room's process, in a fresh engine per event
  with no network, files, environment or children (`mod_limits`), and repeated failures turn it
  off. Its package is pinned by a SHA-256 checked before each start; its views run in an
  opaque-origin frame with hash-pinned scripts and no network.
- MOD-15: Install, grant, consent to an update that adds or widens anything (shown as a
  difference), enabling a third-party or security-sensitive mod, and safe mode are the user's
  alone; consent copy comes from the manifest. Other updates apply after a delay and can be rolled
  back. The EA and agents at `full` MAY switch bundled and theme mods, never a `required` one off;
  safe mode holds every third-party mod off.
- MOD-23: Third-party mods MAY contribute settings, commands, slash commands, webhook senders,
  views, file viewers, status items, notification kinds, context text, themes, audit kinds,
  schedules and agent events (type, agent id and time only); all else is bundled only.

## 18. Public surfaces

- PUB-1: The control room listens on loopback and refuses a `Host` that is not its own.
- PUB-2: Without a credential only these answer: liveness, the loopback local-token exchange,
  sign-in and first enrolment, device pairing, the app-association file, `POST /hooks/<id>`, share
  links (`GET`, `HEAD`) and the static client shell.
- PUB-3: Each public route MUST match an exact anchored path, read only the database, and be rate
  limited per client address (IPv6 by /64), with no shared cap others can drain.
- PUB-4: A share link is a frozen copy of one file behind a 32-byte random token, shown once and
  stored as SHA-256. Sharing is off by default; unknown, revoked, expired and disabled links give
  the same 404, and `share_rate` applies.
- PUB-7: A share page is rendered once, at share time, with no script or cookie, `no-store`,
  `noindex`, `no-referrer`, `nosniff` and `default-src 'none'`; downloads are never HTML or SVG. A
  file is shared only after path checks, a key and credential name deny list, `share_size` and a
  secret scan.

## 19. Client contract

- API-1: Success is `{data, meta}`; an error is `{error: {title, detail}}` with 400 invalid, 401
  no credential, 403 reserved or cross-origin, 404, 409 wrong state, 413, 415, 422 secret in an
  answer, 429 or 503 retry.
- API-2: Every request body, query and path parameter MUST be validated against a schema shared by
  server and client. Failure: 400, title `Invalid request`, detail `path: message` joined by `; `.
- API-4: JSON `GET` responses carry a strong `ETag`; `If-None-Match` (weak comparison) answers
  304; the API is `no-store`. State without a stream is polled conditionally, paused while hidden
  or offline and fired at once on return.
- API-6: Streams are server-sent events with a keepalive every `sse_keepalive`. The agent stream
  resumes from a cursor (`after` or `Last-Event-ID`); too large a gap sends a fresh backlog.
- API-7: Lenient reads: a client MUST fail only on a wrong outer shape. A bad field takes a
  default, a bad list item is dropped, an unknown enum value takes a safe default (`idle` for
  status), and each repair is reported.
  Why: an older client must survive a newer server.
- API-8: Writes need a JSON content type and, from browser sessions, the control room's own
  `Origin`. Bodies other than uploads are capped at `body_max`.
- API-9: Auth is one of: the local token (`Authorization: Bearer`, loopback only); a passkey
  session (HttpOnly, SameSite cookie, `session_life`, user verification); an identity proxy's
  signed assertion, verified; a paired device proof. The first passkey needs a browser already let
  in or a single-use setup code printed on the host. Sign-in, setup and pairing are rate limited.
- API-11: Pairing takes a single-use 128-bit code (`pair_ttl`): the device posts
  `{code, name, platform, public_key}` (P-256) and gets `{device_id, scopes}`. Its proof is
  `Authorization: SetiDevice <JWS>`, header `{alg: ES256, typ: seti-device+jwt, kid: <device_id>}`,
  claims `{htm, htu, iat, jti}`, `iat` within 60 s, `jti` single use. A refused proof answers 401
  and MUST NOT fall back to another credential. Scope `widget` reads one redacted summary: agents
  that need the user with reason lines, a few agents with status, counts and today's cost.
- API-15: A client that cannot reach the server keeps its data and shows no error until it
  answers. After a deploy, a view that fails to load reloads once per build if the server answers
  and no form is unsaved, else offers a reload. A failure toast stays until dismissed.
- API-17: Every flow, full configuration included, MUST work on a phone-sized client.
- API-18: A file for a message uploads as one request before the message goes out, at most
  `upload_file`; the client MUST refuse a larger file without sending it and name the limit. While
  a file uploads the client shows its bytes sent of the total, and the same for the draft's files
  together, and lets the user cancel it. After `upload_stall` without a byte the upload is
  `stalled`, with retry and removal. A failed upload shows its reason (too large, connection lost,
  or the server's refusal) with the file and in a failure toast. The server gives an upload up
  after `upload_idle` without a byte or `upload_time` in all, and keeps nothing of it.

## 20. Conformance

### 20.1 Core

An implementation is SETI-compatible when it meets all of:

1. Agent state and derived status: ENT-1 to ENT-4, ENT-13 to ENT-15, ENT-20 to ENT-22; RT-2, RT-6.
2. Turn lifecycle: TURN-1 to TURN-8, TURN-11 to TURN-14, TURN-18.
3. Update delivery: UPD-1 to UPD-8, UPD-11, UPD-13.
4. Attention: ATT-1 to ATT-11, ATT-14 to ATT-18, ATT-21, ATT-23, ATT-25.
5. Actors and reserved powers: ACT-1 to ACT-6.
6. Permission requests with timeout: PERM-1 to PERM-8, PERM-14; guards GRD-1, GRD-4.
7. Questions and levels: LVL-1 to LVL-5, LVL-8 to LVL-13.
8. Resilience: RES-1 to RES-9, RES-11, RES-12.
9. Audit chain: AUD-1 to AUD-12.
10. Client contract: API-1 to API-9.

### 20.2 Profiles

| Profile       | Adds                                                                          |
| ------------- | ----------------------------------------------------------------------------- |
| Sandbox       | all SBX, EGR, HST, CAP, SEC and CHG; PERM-10, PERM-13; GRD-2, GRD-7 to GRD-12 |
| Shared tools  | all TOOL (requires Sandbox)                                                   |
| Events        | all CHN; PUB-2 (hooks)                                                        |
| Pull requests | all PR                                                                        |
| Team          | all CHAT                                                                      |
| Assistant     | all EA; LVL-6                                                                 |
| Separate node | all NODE                                                                      |
| Mods          | all MOD                                                                       |
| Sharing       | PUB-4, PUB-7                                                                  |
| Devices       | API-11                                                                        |
| Storage       | RES-16 to RES-19                                                              |

An implementation without the Sandbox profile MUST NOT claim that agents are untrusted, and MUST
treat every agent as holding the user's access.

## 21. Security considerations

- The API runs commands as its user. Whoever drives it owns the host; hence ACT-1, PUB-1 and
  API-9.
- The sandbox is the boundary for agents. Permission rules and the classifier are not; they bind
  the runtime's tools, not what a shell command can do.
- The egress proxy cannot read tunnelled traffic, and it reads request bodies only as EGR-14
  says. A placeholder sent in another body, or to an allowlisted host the proxy does not
  terminate, is not detected; it is still only a placeholder.
- A webhook delivery that carries its secret as a bearer or shared token proves the sender but not
  the body, and puts the secret on the wire with every delivery.
- A custom sender definition decides how a public path authenticates, which is why only the user
  writes one (CHN-19).
- An unsandboxed agent can read every secret on the host.
- Approval is review, not proof: a shared tool, knowledge note or mod the user allows unread runs
  with each agent's access. Cards therefore show the whole artefact and only the difference on
  update.
- Prompt injection reaches agents through updates, chat, knowledge and mod text. Wrappers and
  provenance lines lower the odds; an agent persuaded by such text acts within its own access.
  The repeat guard, automatic-turn pause and chat holds bound the damage in turns.
- Delegates share one guard set (ACT-3). A new reserved power MUST be added there, not per route.
- The audit chain detects rewriting and removal only against a head stored outside the user's
  reach (AUD-8).
- A scripted third-party view may still leak what its mod hands it through browser channels no
  policy closes; consent MUST say so.
- Push payloads carry reason lines and closing lines; they are redacted (SEC-8) but leave the
  host.

## 22. Work in progress (non-normative)

- Multi-node: a control plane with remote nodes that run agent sessions. Affects ENT-13, SBX, CAP
  and RES-1 to RES-4.
- Repository registry removal: agents clone for themselves (TURN-9); the remaining registry fields
  on the agent and repository tools at `full` will go. PR-1 already needs no registry.
- Public paths for mods: declared, not available.
- Third-party mod install stays behind a developer switch until its runtime is reviewed.
- Native device clients beyond the `widget` scope.

## Appendix A. Reference constants

Values the reference implementation uses for the named constants. An implementation MAY choose
others.

| Area         | Constant: reference value                                                                                                                                                                                                                                                                                                                                                              |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sessions     | `idle_close` 15 min. `interrupt_grace` 5 s.                                                                                                                                                                                                                                                                                                                                            |
| Updates      | `wake_debounce` 5 s. `wake_max` 30 s. `batch_updates` 20. `update_body` 6000 characters. `auto_turns` 20 in `auto_window` 60 min.                                                                                                                                                                                                                                                      |
| Attention    | `stall_after` 20 min. `stall_check` 1 min. `push_cap` 5 in `push_window` 10 min. `focus_ttl` 45 s. `focus_report` 20 s. `call_ttl` 15 s. `away_after` 5 min. `ask_remind` 15 min.                                                                                                                                                                                                      |
| Brief        | `brief_needs` 5. `brief_changes` 6.                                                                                                                                                                                                                                                                                                                                                    |
| Changes      | `chg_pending` 5. `chg_hourly` 10. `chg_expiry` 24 h. `mcp_off_listed` 8.                                                                                                                                                                                                                                                                                                               |
| Caps         | `mem_cap` 30% of host RAM in whole GB, 6 to 16 GB. `cpu_cap` 3 cores at half the control room's weight.                                                                                                                                                                                                                                                                                |
| Shared tools | `tool_schema` 30 properties, depth 4, 8 KB; description 20 to 1500; timeout 1 to 600 s (default 120); 5 needs of 1 to 5 hosts. `tool_script` 64 KB. `tool_output` 256 KB.                                                                                                                                                                                                              |
| Events       | Event `title` 200, `detail` 2000, `kind` 80. Subscription `events` 20 kinds. Log excerpt 1000. `route_retry` 30 s to 1 h, 12 attempts.                                                                                                                                                                                                                                                 |
| Webhooks     | `hook_replay` 24 h. `hook_limits`: body 256 KB, 60 a minute per channel, 600 overall. Sender `max_age_s` 30 s to 1 day (default 300 s); detail 0 to 2000 characters (default 1000).                                                                                                                                                                                                    |
| Filters      | `filter_limits`: code 10,000 characters; 32 MB; compute and wall 1 s; 2 workers, 2 s wait for one; output 16 KB; 20 log lines. `filter_warn` 3. `filter_samples` 20, each at most 256 KB.                                                                                                                                                                                              |
| Pollers      | `poller_limits`: interval 1 min to 1 day (default 5 min); timeout 5 to 120 s (default 30); compute 1 s unawaited, 10 s a run; 48 MB; 500 items; output 1 MB; state 16 KB; 3 runs at once.                                                                                                                                                                                              |
| Poller fetch | 20 requests a run, 5 redirects, 4 MB each, 12 MB a run. `poller_backoff` 6 h. `fail_streak` 5 (reminders 3).                                                                                                                                                                                                                                                                           |
| Reminders    | `reminder_limits`: interval 1 min to 7 days; 5 s; 256 MB; message 2000; state 16 KB. `cron_catchup` 1 h.                                                                                                                                                                                                                                                                               |
| PRs          | Create request 50 links. `pr_poll` 60 s. `pr_skew` 5 s. `subagent_wait` 30 min.                                                                                                                                                                                                                                                                                                        |
| Threads      | `thread_cap` 50. `dm_window` 24 h. `reply_settle` 10 s. `thread_rate` 10 an hour. `thread_quiet` 7 days. `thread_age` 30 days.                                                                                                                                                                                                                                                         |
| Chat         | Message 4000. Active agent: running, session open, or updated within 12 h. `chat_burst` 12 in 15 min. `chat_loop` 6 in 15 min.                                                                                                                                                                                                                                                         |
| Questions    | Answer batch 100 items. `notes_waiting` 10. Index 1500 characters. `note_stale` 3 failed checks in a row, or unverified 30 days (fact, environment) or 90 days (how-to, gotcha).                                                                                                                                                                                                       |
| Assistant    | `ask_ttl` 10 min. `settle` quiet 45 s, at most 3 min. `call_silence` 30 s. `wake_phrase` 2 to 40 characters, at most 4 words. `keep_awake_seconds` 5 to 600.                                                                                                                                                                                                                           |
| Resilience   | `stop_grace` 7 s. `resume_pace` 3 starts 2 s apart, 20 s between groups. `grant_ttl` 15 min. `send_window` 24 h.                                                                                                                                                                                                                                                                       |
| Storage      | `orphan_grace` 1 h. `size_walk` 400,000 entries or 20 s per folder.                                                                                                                                                                                                                                                                                                                    |
| Audit        | `audit_keep` 365 days. Summary 300. Detail string 500.                                                                                                                                                                                                                                                                                                                                 |
| Mods         | Storage 64 KB a value, 1 MB a mod. Ask 10 min, 3 open a mod. Update delay 24 h. Command timeout 1 to 600 s. Schedule 5 min to 1 day.                                                                                                                                                                                                                                                   |
| Mod engine   | `mod_limits`: 32 MB; compute 5 s; wall 10 s (schedule 30 s); 50 calls; 10 fetches; queue 20; 60 events a minute; 20 failures an hour turn the mod off.                                                                                                                                                                                                                                 |
| Sharing      | Preview pages 1 to 50. `share_rate` a minute per client: 30 misses, 120 pages or downloads, 600 images. `share_size` 10 MB. Expiry 1, 7 or 30 days.                                                                                                                                                                                                                                    |
| Client       | `sse_keepalive` 15 s. `body_max` 8 MB. `session_life` idle 7 days, absolute 30 days. Setup code 15 min. Attempts per 10 min: 20 sign-in, 20 setup, 10 pairing. `pair_ttl` 5 min.                                                                                                                                                                                                       |
| Uploads      | `upload_file` 25 MB. `upload_stall` 30 s. `upload_idle` 60 s. `upload_time` 30 min.                                                                                                                                                                                                                                                                                                    |
| Opinions     | `opinion_sizes`: question 8,000, context 60,000, files 40,000 in all, answer 8,000 characters. `opinion_files` 5. `opinion_rate` 1 at a time, 20 an hour, 60 a day an agent. Time 5 min. 4,000 output tokens. $1 a call.                                                                                                                                                               |
| Dreams       | Window 01:00 to 05:00. `dream_gap` 2 min. `dream_retry` 10 min. `dream_steps` 60. `dream_time` 20 min. `dream_budget` $1. Night budget $5. `dream_gates`: five-hour use 60%, weekly 85%, load 0.75 x cores, 5 GB free. `dream_digest` 40,000 characters. Memory folder 512 KB, 100 files. `dream_proposals` 10. `proposal_expiry` 7 days. `trash_keep` 14 days. `trash_item_max` 5 GB. |

## Appendix B. Retired identifiers

Each was merged into a neighbouring requirement, except EA-13, EA-14 and MOD-22, which were
removed:
ENT-5, ENT-6, ENT-9, ENT-12, ENT-16, ENT-18, ENT-19, TURN-2, TURN-4, TURN-6, TURN-10, TURN-13,
TURN-16, UPD-6, UPD-7, UPD-10, UPD-12, ATT-2, ATT-6, ATT-12, ATT-15, ATT-17, ATT-19, ATT-20, ATT-22,
ATT-24, ATT-26, ATT-27, ATT-28, ACT-2, ACT-4, SBX-3, SBX-4, SBX-5, SBX-6, SBX-8, SBX-10, EGR-2,
EGR-3, EGR-6, EGR-8, EGR-9, EGR-11, PERM-3, PERM-6, PERM-9, PERM-11, GRD-3, GRD-5, GRD-6, GRD-9,
GRD-11, CHG-4, CHG-6, CHG-8, CHG-9, HST-3, HST-6, HST-7, CAP-3, CAP-4, SEC-3, SEC-4, SEC-6, SEC-7,
SEC-9, SEC-12, SEC-13, TOOL-3, TOOL-4, TOOL-6, TOOL-8, TOOL-9, TOOL-11, TOOL-12, CHN-2, CHN-3,
CHN-4, CHN-5, CHN-8, CHN-9, CHN-10, CHN-11, CHN-13, CHN-14, CHN-15, CHN-16, CHN-18, CHN-21, CHN-22,
CHN-23, CHN-24, CHN-26, CHN-27, CHN-28, CHN-30, PR-3, PR-5, PR-7, PR-11, CHAT-2, CHAT-4, CHAT-5,
CHAT-7, LVL-2, LVL-7, LVL-9, LVL-11, LVL-12, LVL-14, EA-2, EA-5, EA-6, EA-9, EA-11, EA-13, EA-14,
EA-15, RES-2, RES-5, RES-7, RES-13, AUD-3, AUD-4, AUD-6, AUD-9, AUD-11, AUD-13, MOD-2, MOD-4, MOD-5,
MOD-7, MOD-9, MOD-10, MOD-11, MOD-13, MOD-14, MOD-16, MOD-17, MOD-18, MOD-19, MOD-20, MOD-21,
MOD-22, MOD-24, PUB-5, PUB-6, PUB-8, PUB-9, API-3, API-5, API-10, API-12, API-13, API-14, API-16.
