# The SETI Protocol

Status: Draft. Describes the reference implementation at its current version and may change.
Category: Specification.

## Abstract

SETI is a protocol for one user to run many coding agents from one control room. It defines agent
and turn state, how outside events become agent input, what counts as needing the user, and the
trust boundary between user, assistant, agents and extensions. An implementation that follows it
is interchangeable for clients, agents and extensions.

## 1. Conventions

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are to be read as in RFC 2119.

- Each requirement has a stable identifier (`AREA-n`). Identifiers are never reused; Appendix B
  lists the retired ones. A range such as `ENT-1 to ENT-6` skips retired identifiers.
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
- ENT-4: Every turn end MUST set `unseen`, `asking`, `closing_line` and `last_error` (errors only).
- ENT-5: `unseen` MUST read false while running and MUST clear only when the user views the agent
  while it is not running.
- ENT-6: `closing_line`: first non-empty line of the turn's result, else of the agent's last text
  in that turn; secrets redacted; at most 120 characters; null while running.
- ENT-7: An archived agent MUST refuse every write except delete, restore and a workspace move (409).
- ENT-8: `home_access` MUST be false for every new agent and MUST only ever change to false.

### 3.2 Turn, session, workspace

| Turn kind | Started by                                        | Prompt author |
| --------- | ------------------------------------------------- | ------------- |
| `user`    | a message the user wrote, a retry                 | user          |
| `updates` | delivered updates with no user text               | control room  |
| `wake`    | background work reporting back in an open session | none          |

- ENT-10: A prompt record MUST carry what applies of: `auto`, `held`, `inputs` (count), `retry`,
  `interrupted`, `queued` (`waiting`, `delivered`, `removed`), `attachments`, `client_id`, `from`.
- ENT-11: Subagent status is `running`, `completed`, `failed`, `stopped` or `unknown`, and MUST be
  derivable from the transcript alone.
- ENT-13: One process owns every open session. A second process MUST NOT steer them.
- ENT-14: A session stays open between turns; idle with no background work, it MUST close after
  `idle_close`.
- ENT-15: Every new process for an agent MUST resume the stored `session_id`.
- ENT-16: A change of sandbox, credential, tool level, access or working directory MUST apply from
  the agent's next turn, by a new process on the same session id.
- ENT-17: Workspace: `id`, `name` (at most 60, unique ignoring case), `position`, `created_at`. An
  agent started without one joins the first by position.
- ENT-19: The last workspace, and one holding any agent (archived included), MUST NOT be deleted.
- ENT-23: A role is a context text, at most one per agent; peers see its first line.

### 3.3 Requests

| Entity                                                                | States                                                      | Holds the agent | Who settles                    |
| --------------------------------------------------------------------- | ----------------------------------------------------------- | --------------- | ------------------------------ |
| Permission request (`tool`, `repeat`, `review`)                       | `pending`, `allowed`, `denied`, `cancelled`                 | yes             | user                           |
| Question (`choice`, `yes_no`, `secret`)                               | `open`, `answered`, `dismissed`, `expired`                  | yes             | user; EA relays (not `secret`) |
| Change request (`allow_host`, `api_key`, `mcp_server`, `shared_tool`) | `pending`, `allowed`, `denied`, `expired`                   | yes             | user                           |
| Knowledge note                                                        | `proposed`, `approved`, `rejected`, `stale`                 | no              | user                           |
| Delegate ask (EA or mod)                                              | `pending`, `allowed`, `denied`, `expired`, `done`, `failed` | no              | user                           |

- ENT-20: One read MUST list every pending request by kind (`questions`, `access`, `plans`,
  `tools`, `notes`) and MUST add no way to answer; each kind is answered on its own route.

### 3.4 Update

- ENT-21: An update has `source`, `kind`, `subject`, `title`, `body`, `url`.

| Source      | Kinds                                                                         | Starts a turn in `wake` |
| ----------- | ----------------------------------------------------------------------------- | ----------------------- |
| `pr`        | `ci_failed`, `ci_passed`, `review`, `comment`, `conflict`, `merged`, `closed` | yes                     |
| `channel`   | free text from the event                                                      | yes                     |
| `agent`     | `idle`, `error`, `stopped`                                                    | yes                     |
| `seti`      | `allowed`, `denied`, `expired`                                                | yes                     |
| `team`      | `mention`, `direct`, `broadcast`                                              | by CHAT rules           |
| `workspace` | `rejected`                                                                    | no                      |

- ENT-22: Update state is derived, not stored: waiting (newer than the last prompt the agent
  read), held (`with_message`), dismissed, quiet (PR-4), read.

## 4. Turn lifecycle

- TURN-1: A user message MUST start a turn, or queue and join a running turn at its next step;
  nothing is interrupted or discarded.
- TURN-3: `interrupt: true` MUST cancel every queued message, interrupt the turn and send this
  message. A runtime that does not yield within `interrupt_grace` is closed.
- TURN-4: Message fields: `prompt`, `interrupt`, `attachments`, `notify_when_done`, `client_id`.
- TURN-5: Only the user writes prompts. A delegate's message request MUST be refused with 403.
- TURN-6: A new agent's first message written by a delegate MUST carry `from` and MUST be prefixed
  for the agent with `This message comes from <author>, not the user.`
- TURN-7: Slash commands MUST be refused while a turn runs and MUST carry no updates.
- TURN-8: A background report in an open session with no running turn MUST set `running` (`wake`).
- TURN-9: An agent start takes a message and no location: the control room MUST create a fresh
  folder and tell the agent to clone what it needs there.
- TURN-10: Only the agent moves its session directory, to an existing directory inside its own
  folders (symlinks resolved), from its next turn.
- TURN-11: A waiting message MAY be taken back until the agent read it; after that 409.
- TURN-12: Stop takes `queued=remove` (default: cancels queued messages, ends `stopped`) or
  `deliver` (carries on into written messages; updates are still taken back). A stopped turn MUST
  NOT start a turn for waiting updates.
- TURN-14: Retry resends the agent's last real message as a new turn, with its attachments and
  `from` mark, and takes no text. 409 while a turn runs or when no message exists.
- TURN-15: A session restart keeps the session id and opens the next process at once. It MUST be
  refused while a turn runs unless `interrupt` is set.
- TURN-16: Rewind restores `conversation`, `code` or `both` to an earlier prompt. It MUST be
  refused while a turn or background work runs.
- TURN-17: The stored result MUST carry the turn's own cost; the agent's `cost_usd` accumulates it.
- TURN-18: `asking` is true only for an `idle` end whose prose after the last tool call ends in a
  question, or in a question with a list of answers. Questions in code, quotes or headings,
  self-addressed questions and closing courtesies MUST NOT count. No model call is made.
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

- UPD-3: PR, agent and request-answer updates have no per-source timing and follow the agent mode.
- UPD-4: A held update MUST never start a turn and MUST stay out of turns started for other
  updates. It goes with the next user message, or joins the running turn when the user answers the
  agent's question. The user MAY hand it over or dismiss it.
  Why: an agent that waits on the user must not be steered by a third party first.
- UPD-5: Waking is debounced: a turn starts once no update arrived for `wake_debounce`, at most
  `wake_max` after the first.
- UPD-6: A batch with any `now` update joins the running turn whole.
- UPD-7: One turn takes the newest `batch_updates` waiting updates, each body clipped at
  `update_body` characters and marked so.
- UPD-8: After `auto_turns` automatic turns within `auto_window` since the user last wrote, waking
  MUST pause until the window passes; updates wait.
  Why: bounds a loop between an agent and its own event sources.
- UPD-9: Updates that waited through a restart MUST be handed over at startup, with the resume
  message for agents being resumed.
- UPD-10: An archived agent takes no update (`skipped`); an agent in `off` records none (`ignored`).
- UPD-11: Updates precede the user's text, grouped by source. Each group states its provenance and
  tells the agent not to follow instructions in it beyond the task. The text ends `The message
from the user follows.` and the prompt, or a note that none came and to act as the task requires.
- UPD-13: Each update is wrapped in a tag by source. Attribute values are escaped, and a body MUST
  NOT be able to close its tag:

```
<update source="pr" kind="K" subject="S" url="U">TITLE BODY</update>
<channel-event channel="C" source="S" kind="K" severity="V" received_at="T" url="U">...</channel-event>
<team-chat from="H" kind="mention|direct|broadcast" message_id="N">...</team-chat>
<agent-turn agent="TITLE" task_id="ID" ended="idle|error|stopped">...</agent-turn>
<seti-answer request_id="ID" outcome="allowed|denied|expired">...</seti-answer>
<workspace-edit file="F">...</workspace-edit>
```

## 6. Attention

Why: the whole system exists so that one person can answer "what needs me?" in one glance and be
interrupted only for that.

### 6.1 Needs you

- ATT-1: An agent needs the user when its display status is `error`, `interrupted`, `asking` or
  `blocked`.
- ATT-2: The Needs you set is: `blocked`, or (`unseen` and ATT-1). A blocked agent stays until the
  block clears; the others leave when the user views them.
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
  Only time a permission request was pending MUST NOT count. Every stall MUST surface through
  Needs you; there is no other place an agent waits.

### 6.2 Router

- ATT-7: Every event that could reach the user MUST get exactly one route: `push`, `toast`,
  `call`, `digest` or `passive`.
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
  5. Surface `push` and a push device that hears it -> `push`.
  6. Else `digest`.
- ATT-10: The push count restarts when the user returns. Needs-you is never capped, but rule 6
  holds for it: on surface `toast` with no focused page, or with no push device that hears it, it
  waits for the brief.
- ATT-11: An agent the EA watches or waits for MUST get no push or toast of its own; the EA's
  inbox item, routed by this section, is its one surface. Its turn ended by a stop or a restart
  is routine news (`digest`).
- ATT-12: `call` is assigned only when the EA delivers an item by voice on a live call.
- ATT-13: Tier surfaces are a notification setting, not a security setting: delegates at full
  reach MAY change them. `urgent` MUST NOT be set below `toast`.

### 6.3 Push

- ATT-14: A push is sent for: a turn end; a status that needs the user; a new reason line; agents
  left interrupted at startup. Kinds: `finished`, `needs_you`, `ea`.
- ATT-15: A push MUST be skipped when the agent is muted or archived, when the same state was
  already notified, when the EA carries the agent, or when the router did not return `push`.
- ATT-16: A device hears about an agent when: the event concerns no agent; or the device reported
  no workspace; or its "active workspace only" setting (default on) is off; or the agent is in the
  workspace it has open.
- ATT-17: A device MUST be skipped while its page shows the agent or has focus (report at most
  `focus_ttl` old).
- ATT-18: Payload: `title`, `body`, `tag`, `url`, `kind`, `badge`. `tag` is the agent id, so a
  newer push replaces an older. `badge` is the Needs you count across all workspaces.
- ATT-19: Body: finished -> `closing_line` or `Ended its turn without a reply`; blocked -> the
  reason line; asking -> `Asks: <question>`; error -> `Failed: <cause>`; interrupted -> `Cut off
by a restart`.
- ATT-20: Pushes MUST be sent only to known push service hosts over HTTPS.
- ATT-21: Re-notify, once each: `ask_remind` after a turn ended on a prose question still
  unanswered (`Still waits: <question>`); when a permission request reaches four fifths of its
  timeout, and no later than 5 min before its end (reason line gains `, times out soon`).
- ATT-22: The per-agent mute and the tiers apply before the workspace rule. Counts the user reads
  on purpose (status bar, app icon, workspace switcher) MUST cover every workspace.

### 6.4 Presence and the brief

- ATT-23: Each visible page reports `{device_id, agents shown, active}` every `focus_report` and
  on focus change. A call is live while the EA polls its inbox as on a call (within `call_ttl`).
- ATT-24: The user is away after `away_after` with no focused page and no live call.
- ATT-25: The first report after an absence builds one brief: up to `brief_needs` agents that need
  the user, with reason lines; then up to `brief_changes` changes (idle agents that changed since
  the user left, quoting `closing_line`; then inbox items routed `push` or `digest`); then a count
  of the rest. Muted agents and tiers set `off` are left out of the agents' own lines only.
- ATT-27: A waiting brief grows across absences, is held in memory only, and closes on every
  device when dismissed or when a call takes it.
- ATT-28: A failure toast stays until dismissed.

## 7. Trust and permissions

### 7.1 Actors

- ACT-1: Every request has one source: user (local token, session, or identity proxy), EA,
  agent (platform tool call, in process), mod (mod API call, in process), device.
- ACT-2: The control room MUST derive the source from the credential or call path, never from a
  request field.
- ACT-3: Reserved powers. Delegates MUST be refused each of these, in the function that performs
  the change and not only at the route or tool list:
  - read or set a secret, credential or connection value; supply a secret question's value;
  - change credentials, connections, SSH keys and hosts, or the network allowlist;
  - change sandbox policy, an agent's sandbox, `home_access` or platform tool level; start an
    agent unsandboxed; open a terminal or run a shell command in an agent;
  - change permission rules, the request timeout or bypass; answer a permission or change request;
  - publish or re-enable a shared tool; approve, reject or edit a knowledge note;
  - write a prompt as the user; create, update or revoke a share link; sign-in, passkeys, devices;
  - install plugins; install, grant or enable third-party mods;
  - and, the EA excepted: answer a question (the EA relays only); change memory or CPU caps and
    compaction; disable or remove a shared tool or switch the repeat guard (the EA after the
    user's yes).
- ACT-4: A refusal is 403 with a message that names who may do it.
- ACT-5: A delegate reaches another agent only through the group chat, which marks the author.
- ACT-6: Agents propose reserved changes with `request_change` (7.6); only the user's own Allow
  applies one.

### 7.2 Sandbox

| Id     | Requirement                                                                                                                                                                                                                         |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SBX-1  | Every agent MUST run sandboxed unless the user chose otherwise for that agent. The choice MUST be visible and audited.                                                                                                              |
| SBX-2  | A sandboxed session has its own process, network, IPC and host-name namespaces. Its only network is loopback, bridged to the agent's egress proxy (7.3).                                                                            |
| SBX-3  | Read-write: the agent's own folder, its platform workspace, a private home, `/tmp`, package caches. Read-only: system, toolchains, runtime configuration, approved shared tool folders. Nothing else of the user's home is mounted. |
| SBX-4  | MUST NOT be visible: other agents' folders, credential stores, SSH and cloud configuration, database and cache sockets, the control room's data and live install.                                                                   |
| SBX-6  | No credential enters the sandbox. The agent holds placeholders.                                                                                                                                                                     |
| SBX-7  | `home_access` adds the top-level non-dot folders of the user's home, read-write. Repository config and hooks in such checkouts MUST be read-only.                                                                                   |
| SBX-8  | An agent MUST fail to start when the sandbox is unavailable. There is no fallback.                                                                                                                                                  |
| SBX-9  | Every command the user runs for an agent (shell command, terminal, side question, rewind helper) MUST run in the same sandbox.                                                                                                      |
| SBX-10 | An unsandboxed agent has the user's access to the host. Credentials and the network allowlist do not apply to it.                                                                                                                   |
| SBX-11 | An agent that starts another MUST start it sandboxed, at tool level `self`, with at most its own access; what was withheld is recorded.                                                                                             |

### 7.3 Egress

| Id     | Requirement                                                                                                                                                                                                                                                          |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| EGR-1  | The proxy allows, in order: the model provider; hosts of the agent's connections; cloud endpoints if cloud access is on; SSH first hops of usable hosts; the shared allowlist plus the agent's own hosts. Everything else is refused with a message naming the host. |
| EGR-2  | Allowlist entries are an exact host or `*.suffix`, with an optional port (default 443). A name that resolves to a loopback or link-local address MUST be refused.                                                                                                    |
| EGR-4  | The proxy terminates TLS only for hosts where it adds a credential, with a local CA name-constrained to those hosts; its key stays outside. Other hosts are tunnelled unread.                                                                                        |
| EGR-5  | A connection's placeholder is `seti-secret-<name>-<32 hex>`, exposed in the connection's variable. The proxy swaps it for the value in the URL path and headers (inside Basic auth too), only on the connection's hosts, port 443. Bodies are not read.              |
| EGR-6  | A request the proxy can read that carries a placeholder to another host MUST be refused (403) and audited. A connection with no value answers 502.                                                                                                                   |
| EGR-7  | With "added by the proxy" on, the proxy sets the connection's header from its template on every request to its hosts; the first matching rule wins.                                                                                                                  |
| EGR-8  | Code-host token: that of the owner the request names when the credential has one, else its default; never another credential's. Minted tokens are cached until shortly before expiry and renewed once on a 401.                                                      |
| EGR-10 | Cloud credentials are short-lived, from the role in the agent's credential, served by the proxy; never the host's own.                                                                                                                                               |
| EGR-11 | SSH is off by default. A host is usable only with a login in the agent's credential for it and each jump host; host keys are pinned; the agent holds only those logins' keys.                                                                                        |
| EGR-12 | Tool servers an agent leaves out MUST be denied to its runtime and get no sign-in from the proxy.                                                                                                                                                                    |

### 7.4 Permission rules and requests

- PERM-1: Rule behaviours: `allow`, `ask`, `deny`, `review`. A rule applies to one agent or all.
- PERM-2: Rules and guards decide first; a classifier then allows or turns down each other call. A
  call it turns down never reaches the user: the agent gets the reason and the audit records it.
  A call an `ask` rule matches, or that nothing decides, becomes a request and the agent blocks.
- PERM-4: Built-in: reads, search and platform tools are allowed for all; shell and edits inside
  the agent's folders are allowed in the sandbox only; killing by name is denied for all.
- PERM-5: Request fields: `id`, `task_id`, `tool_name`, `kind`, `summary`, `input`, `reason`,
  `suggestions`, `editable`, `state`, `created_at`, `timeout_at`, `timed_out`.
- PERM-6: Decisions: `allow` (this call), `always` (adds the suggested allow rules; scope `agent`
  or `global`), `deny` (optional message to the agent).
- PERM-7: Timeout is one install-wide setting: off, 15 min, 1 h (default), 4 h, 24 h, counted from
  when the request was raised. A new value applies to waiting requests.
- PERM-8: At the deadline the request MUST be denied with `timed_out`. The agent is told nobody
  answered, that it is no judgement on the action, and to carry on or ask again. A timeout adds no
  rule and touches no other request.
  Why: an agent must never wait on the user for ever, and must not read silence as refusal.
- PERM-9: A request whose session is gone closes as `cancelled`.
- PERM-10: Bypass is per agent, off by default, set only by the user for 2, 8 or 24 h, then ends
  by itself. In bypass `ask` rules and the classifier do not apply; deny rules, guards, review
  rules, the repeat guard and the sandbox still hold. Turning it off or its expiry MUST take
  effect at once. Each change is audited and noted in the transcript.

### 7.5 Guards

- GRD-1: Shell guard, every agent, whatever the rules or bypass: recursive delete with a computed
  target or outside the agent's folders; delete through `xargs`; forced clean; output flags to
  paths outside the agent's folders; kill by name or pattern; writes under credential folders.
- GRD-2: Unsandboxed agents also: `find` with exec or delete; search with a preprocessor; opening
  a browser.
- GRD-3: Nested shell scripts (`-c`, `eval`) MUST be checked too. Each refusal is audited.
- GRD-4: Repeat guard: per thread (agent and each subagent apart), a call identical to the last
  after 2 identical results MUST be held as a `repeat` request before the third run. Calls and
  results are compared by hash, without timings, temporary paths or the call's description. A
  different call or result, or a user message, resets the count.
- GRD-6: `allow` runs once and resets; `always` lifts that exact call for the process; `deny`
  tells the agent. The guard asks in bypass. Only the user turns it off; the EA with the user's yes.
  Why: an injected loop costs at most two runs before someone looks.
- GRD-7: A review rule names a tool-server tool or a whole server. Each call it names MUST be held
  as a `review` request, in bypass too, with no `always`. A deny rule wins over review. If review
  rules cannot be read the call MUST be denied.
- GRD-8: The user MAY edit a held call's top-level text fields before `allow`, only when the
  request shows the input whole and unredacted. The audit records field names, never values.
- GRD-10: Outward: a tool-server call unless its name reads as a read (verb list) or the tool
  declares no writes; a shell command that pushes, publishes, deploys, mutates a remote API or
  opens a remote shell; any unknown name. Every outward call MUST be audited and counted on the
  agent.

### 7.6 Change requests

| Id    | Requirement                                                                                                                                                                                                                                                                                                     |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CHG-1 | Kinds and fields: `allow_host {host, port}`; `api_key {env, hosts[1..5]}`; `mcp_server {server}`; `shared_tool {...}` (section 9). Each carries `reason` (10 to 500).                                                                                                                                           |
| CHG-2 | MUST be refused outright: hosts on the machine or its networks; wildcards over a public suffix. Sandbox, bypass, rules, secret values and other agents are never requestable.                                                                                                                                   |
| CHG-3 | Per agent: one pending request per identical change, `chg_pending` pending, `chg_hourly` per hour. A request expires after `chg_expiry`.                                                                                                                                                                        |
| CHG-4 | The answer is `{decision: allow, scope, value?}` with scope `agent` or `all`, or `{decision: deny}`. `value` is accepted only for `api_key`.                                                                                                                                                                    |
| CHG-5 | Allow applies as the user: host to the agent's own allowlist (default) or the shared one; server on for the agent; connection added to the asking agent's credential with those hosts. A connection that already has the variable joins only on the same hosts and takes a pasted value only while it has none. |
| CHG-7 | The pasted value MUST travel only in the user's Allow and MUST NOT enter the request, the agent's update, the transcript, events, errors or the audit.                                                                                                                                                          |
| CHG-8 | The agent gets one `seti` update with the outcome and whether a value is in place.                                                                                                                                                                                                                              |
| CHG-9 | An unsandboxed agent's `allow_host` and `api_key` requests MUST be refused (409).                                                                                                                                                                                                                               |

### 7.7 Hostile repositories

| Id    | Requirement                                                                                                                                                                                                                                                          |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HST-1 | Everything in an agent's folder is input the agent wrote. It MUST NOT run code on the host.                                                                                                                                                                          |
| HST-2 | The control room runs version control in an agent-writable folder only with hooks, filters, external commands, helpers and transports disabled, ignoring system and user config. A repository pointer file is followed only when the repository records that folder. |
| HST-4 | The capability probe of a folder a sandboxed agent works in MUST run inside that agent's sandbox. Any other agent-writable folder is probed with the user's settings only. Why: project settings start hooks and tool-server commands.                               |
| HST-5 | Sandboxed agents' file tools MUST NOT edit runtime settings, hooks or tool-server config in their folders; unsandboxed agents are asked.                                                                                                                             |
| HST-6 | Text from the code host (titles, branches, checks, comments) is untrusted: rendered as text, delivered as update or tool result.                                                                                                                                     |
| HST-7 | An HTML file an agent wrote MUST render only in a frame with an opaque origin, no script by default and no network.                                                                                                                                                  |

### 7.8 Resource caps

| Id    | Requirement                                                                                                                                                                                                       |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CAP-1 | Each agent's process tree (subagents and shells included) runs under a memory cap (`mem_cap`) and a CPU quota (`cpu_cap`), below the control room's scheduling weight.                                            |
| CAP-2 | At the memory cap the largest tool process MUST be stopped before the runtime; the rest of the tree continues. A kill MUST become one transcript note naming what was stopped; if the runtime died the turn ends. |
| CAP-4 | The agent MUST be told its memory cap and core count.                                                                                                                                                             |
| CAP-5 | A cap change reaches running agents at once. Agent processes MUST NOT outlive the control room that started them.                                                                                                 |

## 8. Secrets and connections

| Id     | Requirement                                                                                                                                                                                                                                                                                                                                                                                            |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| SEC-1  | A credential bundles: code-host tokens (default and per owner), a cloud role, SSH hosts, connections. One built-in default exists. Credentials apply to sandboxed agents only.                                                                                                                                                                                                                         |
| SEC-2  | Connection fields: `name`, `kind`, `env`, `hosts` (at most 20, exact or `*.suffix`), `header {name, template}`, mint settings, value slots (set or unset only). Kinds: `key`, and `client_credentials`, `refresh_token`, `jwt_bearer`, which mint short-lived tokens.                                                                                                                                  |
| SEC-4  | `env` MUST NOT be a variable the control room or runtime sets. Hosts MUST NOT cover the model provider or the code host.                                                                                                                                                                                                                                                                               |
| SEC-5  | Values are write-only: never returned (reads give status only), sealed at rest with AES-256-GCM, a random 12-byte IV and the secret's name as associated data. The key is a file outside the database and outside every backup.                                                                                                                                                                        |
| SEC-7  | A new connection is in no credential. A connection is switched on per credential.                                                                                                                                                                                                                                                                                                                      |
| SEC-8  | A value MUST NOT appear in: logs, transcripts, audit, events, errors, chat, the EA's context, a mod's input or output, or any API response.                                                                                                                                                                                                                                                            |
| SEC-9  | Text stored or shown from agents (questions, closing lines, summaries, audit) MUST pass credential redaction.                                                                                                                                                                                                                                                                                          |
| SEC-10 | A user answer in free text that looks like a credential MUST be refused (422) and nothing in its batch stored.                                                                                                                                                                                                                                                                                         |
| SEC-11 | Secret question (`ask_secret {name, purpose, hosts}`), every agent at any level. Only the user sends the value, alone on its own route. Sandboxed: sealed as a connection for those hosts (required) in the agent's credential. Unsandboxed: a 0600 file in the agent's workspace that no file view, handoff, share or archive serves. The agent's call returns where the value went, never the value. |
| SEC-13 | A secret question expires when its call is cancelled, its session closes, or the control room restarts. A value sent after that is kept nowhere.                                                                                                                                                                                                                                                       |
| SEC-14 | Webhook secrets are sealed; only the user supplies or reveals one; reveal works once.                                                                                                                                                                                                                                                                                                                  |

## 9. Shared tools

| Id      | Requirement                                                                                                                                                                                                                                                                                                                                      |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| TOOL-1  | A shared tool is one script an agent proposed and the user allowed for every agent. Only the user publishes or re-enables one; the EA MAY disable or remove one after the user's yes; agents MAY only list them.                                                                                                                                 |
| TOOL-2  | Proposal fields, closed set: `name`, `description`, `path`, `input`, `writes`, `timeout_seconds`, `needs {env, hosts}`. `input` is a closed subset of JSON Schema: an object, no references, bounded (`tool_schema`).                                                                                                                            |
| TOOL-4  | The control room reads the file itself at proposal time: one regular file in the agent's folders, no symlink, UTF-8, at most `tool_script`.                                                                                                                                                                                                      |
| TOOL-5  | The snapshot is stored with one SHA-256 over definition and script. The card shows the whole script and hash. Allow publishes exactly the snapshot. Why: what the user read is what every agent runs.                                                                                                                                            |
| TOOL-6  | A new version shows its changes against the published one. An update filed against a version since replaced MUST be refused.                                                                                                                                                                                                                     |
| TOOL-7  | Publishing grants no key and no host. A tool loads into an agent only when it is on and the agent's credential carries a connection for every `needs` variable on the hosts named.                                                                                                                                                               |
| TOOL-8  | Exposure: tool server `shared`, tool name `mcp__shared__<name>`, with read-only and open-world hints from `writes`.                                                                                                                                                                                                                              |
| TOOL-10 | Call: arguments validated against the schema; script started with an argument list and no shell; arguments as one JSON object on stdin; stdout (at most `tool_output`) returned as text, and as structured content when it is a JSON object; non-zero exit is an error carrying stderr. At the time limit the script's process group is stopped. |
| TOOL-12 | The script runs where the calling agent runs. In the sandbox calls are allowed without asking; outside it each call asks unless a user rule allows it.                                                                                                                                                                                           |

## 10. Inbound events

| Id     | Requirement                                                                                                                                                                                                                                                                                                                               |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CHN-1  | A channel has a source: `webhook`, `poller` or `reminder`. All three feed one event path.                                                                                                                                                                                                                                                 |
| CHN-2  | Event fields: `id`, `channel`, `source`, `severity` (`info`, `success`, `warning`, `critical`; unknown reads as `info`), `title`, `detail`, `url`, `dedupe_key`, `kind`, `subject`, `state` (`down`, `up`, null), `occurred_at`. Event text passes credential redaction.                                                                  |
| CHN-4  | Events are unique per `(channel, dedupe_key)`. Per `(channel, subject)` a repeated state is a duplicate and a first-seen `up` is a baseline with no event.                                                                                                                                                                                |
| CHN-6  | Webhook endpoint: `POST /hooks/<id>`, `id` 24 URL-safe characters from 18 random bytes. Any other method or path answers 404.                                                                                                                                                                                                             |
| CHN-7  | Every delivery MUST be verified with the channel's secret before any parser reads it: HMAC-SHA256 of the raw body, hex, compared in constant time; the generic source also accepts the secret as a bearer token. A mod's source names the signature header and the control room verifies; while the mod is off its deliveries answer 503. |
| CHN-9  | A delivery id (header, else body hash) is accepted once per channel within `hook_replay`. Body size and rates are limited (`hook_limits`), the overall rate before the channel lookup.                                                                                                                                                    |
| CHN-11 | Responses: 200 `{status, reason}` for `accepted`, `duplicate`, `ignored`; 400; 401; 404; 413; 415; 429 with `Retry-After`; 503.                                                                                                                                                                                                           |
| CHN-12 | A poller is a script run on an interval in an engine with no files, environment, timers or processes, under `poller_limits`. It is given `fetch`, `parseFeed`, `log`, `state`, `since` and returns items `{key, title?, kind?, url?, body?, fields?, fingerprint?}` or `{items, state}`.                                                  |
| CHN-14 | `fetch` reaches only allowlisted hosts plus the poller's extra hosts, on public addresses. Secrets are named in `secretHeaders` and `secretQuery`; the script never sees a value: values read `[secret]` in everything returned and are dropped on a cross-origin redirect.                                                               |
| CHN-17 | A poller's first successful run is a baseline. After it: new key -> `<kind>` or `new`; changed fingerprint -> `<kind>.changed` or `changed`; with gone detection on, a key missing from a complete run -> `<kind>.gone` or `gone`.                                                                                                        |
| CHN-18 | A failing poller backs off by doubling its interval, up to `poller_backoff`. A run of failures (`fail_streak`) reports `poller_failed` or `reminder_failed` once; the next success reports `poller_recovered` or `reminder_recovered`.                                                                                                    |
| CHN-19 | Only the user gives a poller extra hosts or secrets, or changes the script of a poller that sends secrets.                                                                                                                                                                                                                                |
| CHN-20 | A reminder is a script run on an interval or a 5-field cron schedule in a named timezone, in a fresh process with no network, environment, child processes or files beyond its own runner, under `reminder_limits`. It returns a message, nothing (skip), or `{message, state}`.                                                          |
| CHN-22 | Due reminders are claimed atomically and the next run moved ahead in the same step, so no restart, overlap or second process fires one twice. Missed runs: an interval reminder runs once and keeps its grid; a cron reminder runs only its newest missed slot, if at most `cron_catchup` old.                                            |
| CHN-25 | A subscription targets `ea` or one agent; one per `(channel, target)`. Fields: `events` (empty takes all; an entry matches a kind equal to it or starting with it plus `.`), `mode` (EA: `report` default, `act`), `delivery` (agent: UPD-2).                                                                                             |
| CHN-26 | An agent at level `self` subscribes only itself. An agent MUST NOT subscribe the EA.                                                                                                                                                                                                                                                      |
| CHN-27 | To an agent an event becomes a `channel` update (section 5); to the EA an inbox item, urgent when `critical`, or `down` with `warning`.                                                                                                                                                                                                   |
| CHN-29 | Each delivery is logged: `status` (`accepted`, `duplicate`, `ignored`, `rejected`, `rate_limited`), HTTP status, reason, a redacted excerpt, and per subscription an outcome (`delivered`, `queued`, `held`, `ignored`, `skipped`, `retrying`) with its reason.                                                                           |
| CHN-30 | A failed route is retried with doubling backoff (`route_retry`).                                                                                                                                                                                                                                                                          |

## 11. Pull requests

- PR-1: The PR set is: every open PR the host's code-host login wrote, in any repository, plus
  every open PR linked to an agent. No repository list is needed.
- PR-2: Links are made by: the agent's own create call (every PR URL in its result); transcript
  evidence that the agent opened the PR or pushed its head branch; the user; a create request. A
  dismissed link MUST never be relinked automatically. A merged or closed PR is unlinked after its
  last update.
- PR-4: PRs linked to an agent that is not archived and takes updates, or that the EA watches, are
  polled every `pr_poll` against the last snapshot. The first sighting is a baseline. Each change
  is one `pr` update to every linked agent. Three kinds are recorded quiet:

| Mark                       | When                                                                      | Agent gets                   |
| -------------------------- | ------------------------------------------------------------------------- | ---------------------------- |
| `not sent: own action`     | the agent posted the comment or review, or merged or closed the PR        | nothing                      |
| `not sent: repeat`         | checks reran on a commit and ended as reported before                     | nothing                      |
| `no wake: nothing pending` | CI passed, no failure was reported before, the agent pushed nothing since | the pass, with its next turn |

Why: an agent woken by its own actions or by news nobody waited for burns turns and attention.

- PR-5: A batch of only quiet updates starts no turn. Quiet updates never count as waiting.
- PR-6: Own action is decided from the agent's tool calls, not the author: an exact id match in a
  posting call's output; else the host login posting on that PR while the call ran (`pr_skew`); a
  merge or close call at the PR's end time. Anything not tied to a call is delivered.
- PR-7: A pass wakes when the last reported result was a failure, or the agent pushed or opened a
  PR since its last CI update.
- PR-8: A failure is reported once per head commit, again only for checks not failed on it before.
  A conflict is reported once per head commit and base branch until the PR merges cleanly again.
- PR-9: Updates for a PR linked to a running subagent wait until it ends, at most `subagent_wait`,
  and are addressed to its parent.
- PR-10: Status fields: `ci` (`success`, `failure`, `pending`, `neutral`), `review_decision`
  (`approved`, `changes_requested`, `review_required`), `mergeable` (`mergeable`, `conflicting`,
  `unknown`). CI rollup: failure > pending > success, else neutral; superseded runs dropped.
- PR-11: PR reads use the host login only, never a credential's tokens.
- PR-12: Fix CI: for each agent linked to an open PR with failing CI, one message naming only its
  PRs: `CI is failing on <refs>. Please fix it|them.` Archived and stopped agents are skipped;
  failing PRs with no agent are counted. The user sends it as a prompt; the EA as a direct message.

## 12. Group chat

| Id     | Requirement                                                                                                                                                                                                                                                                           |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CHAT-1 | One chat joins the user, the EA and every agent. Authors: `user`, `ea`, `task`, `mod`. Handles: lowercase letters, digits, hyphens, at most 24, assigned from the title and renamed with it; `all`, `ea`, `user` reserved.                                                            |
| CHAT-3 | A public message reaches mentioned agents; `@all` or an EA post reaches every active agent. An idle agent starts a turn; a running one takes a mention from the user or EA now, from an agent or mod at its next step. A turn is never cut short.                                     |
| CHAT-5 | Agent-written traffic is held past `chat_burst` deliveries to one agent and `chat_loop` exchanges between two agents. A muted agent skips mentions.                                                                                                                                   |
| CHAT-6 | A direct message names one recipient (agent or EA). Only author, recipient and user see it, in lists, search, streams and transcripts; others read `[direct message hidden]`. A muted agent gets it at its next turn. The audit records sender, recipient and length, never the text. |
| CHAT-8 | Agents MAY post by appending to a chat file in their workspace: first line `direct @handle` or `public`. While the last message is direct, an unmarked append MUST be refused. Why: a private answer must not land in public by default.                                              |
| CHAT-9 | A side question to an agent forks its session read-only, with no tool servers, and writes nothing back; its answer is stored apart from the conversation.                                                                                                                             |

## 13. Agent-to-platform tools

- LVL-1: Each agent has a level, `off`, `self` (default) or `full`, that only the user changes.
- LVL-2: Tools run inside the control room as that agent; no token enters the sandbox; the audit
  names the agent.

| Level  | Tools                                                                                                                                                                                |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `off`  | own status line; own working directory; file handoff; `ask_secret`                                                                                                                   |
| `self` | + `request_change`; knowledge propose, search, verify; read platform state; change only itself (title, colour, pin, update mode, PR links, context, role, handle, own subscriptions) |
| `full` | + every action the EA has, on any agent                                                                                                                                              |

- LVL-3: The level MUST be checked on every call, not only in the tool list.
- LVL-4: At `self`, tools take no argument naming an agent; the control room fills in the caller.
  A reference to another agent is refused without revealing which agents exist.
- LVL-5: At `full` an agent MUST NOT stop, archive, delete, rewind or restart itself, nor retry
  its own turn.
- LVL-6: Parity: every platform action that is not a reserved power MUST exist for the EA and at
  `full`; exceptions are an explicit list on each side. No tool name on either side may approve,
  allow, bypass, share or publish.
- LVL-8: An agent asks through the runtime's question tool: 1 to 4 questions per call, each a
  prompt and 1 to 8 options, held until every one is answered or dismissed. Types: choice (single
  or multiple) and `yes_no` (options exactly yes and no), each with a free-text alternative. A
  recommended option is first and its label ends `(Recommended)`.
- LVL-10: Answers arrive in one batch `{items: [{action: answer, id, selected, other} | {action:
dismiss, id}]}`. Every item is validated before any is stored. Questions closed meanwhile are
  skipped.
- LVL-11: The agent receives its own input plus `answers` keyed by question text. A dismissed
  question says so; a group only dismissed is a denial telling the agent to use its judgement. A
  stopped turn or ended session expires the group.
- LVL-13: Question guidance, given to every agent: do not ask for a go-ahead on reversible work
  inside the request; take and name a clearly recommended option; ask only when the choice cannot
  be undone, acts outward, changes scope or is balanced; never end a turn on a question in prose;
  never ask for a secret except through `ask_secret`.
- LVL-14: House rules, given to every agent and, by a hook at subagent start, to every subagent:
  no foreground sleep or polling (run long commands in the background and end the turn); stop
  processes by exact PID; recursive delete only on literal paths in own folders; tool names are
  case sensitive.
- LVL-15: Knowledge notes: agents at `self` or `full` propose, at most `notes_waiting` each. Only
  a bounded index of approved titles reaches prompts, framed as reference, not instructions.
  Proposals with credentials or private paths are refused. Notes go stale by `note_stale`.

## 14. The assistant

| Id    | Requirement                                                                                                                                                                                                                                                                                                     |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| EA-1  | The EA is a separate process with its own token. It acts only through the API the user's client uses; every change is audited as the user's with `via: ea`.                                                                                                                                                     |
| EA-2  | The EA MUST NOT hold reserved powers (ACT-3) and has no tool for code-host writes (merge, approve, comment, push).                                                                                                                                                                                              |
| EA-3  | Each tool that changes something takes a confirmation. The first call records an ask (tool, arguments, summary, change key) and does nothing; the same change asked again while open returns that ask. Only the user's yes runs it.                                                                             |
| EA-4  | A yes counts only for an ask from an earlier user turn or an earlier EA process, within `ask_ttl`. One ask takes one answer; an allowed call runs once with the recorded arguments. Why: the model cannot ask and approve in the same breath.                                                                   |
| EA-6  | The user MAY answer an ask by text, voice or notification; delegates MUST NOT.                                                                                                                                                                                                                                  |
| EA-7  | The EA reaches agents only by group chat, public or direct. A direct message joins a running turn or starts one; it never interrupts.                                                                                                                                                                           |
| EA-8  | Inbox item kinds: `followup`, `reminder`, `watch_event`, `channel_event`, `team_mention`. A new event for the subject of an undelivered item replaces it.                                                                                                                                                       |
| EA-9  | Unasked reports get read tools only. Exception: a report made only of items from `act` subscriptions MAY send a direct message to an existing agent, and MUST tell the user.                                                                                                                                    |
| EA-10 | Off a call, ordinary watch and channel items wait for a quiet period (`settle`); urgent items, follow-ups, reminders and mentions go at once. On a call nothing interrupts the user: items join after the user's next turn, and a needs-you item gets one line of its own after `call_silence` of full silence. |
| EA-12 | After each reply, without a model call: if the reply promised to reach an agent and no tool did, the EA gets one more run. Once per turn.                                                                                                                                                                       |
| EA-13 | Voice settings: `wake_enabled` (default off), `wake_phrase`, `language` (one code from a closed list, or code-switching), `keep_awake_seconds`.                                                                                                                                                                 |
| EA-15 | The EA reads the since-you-left brief for a call and says it in one sentence.                                                                                                                                                                                                                                   |

## 15. Resilience

- RES-1: On a stop signal the control room MUST, within `stop_grace`: record each running turn
  (`user`, `updates` or `wake`, and its background count), audit the stop, and interrupt each turn
  so its session is saved. Agents stay `running` in the store across the stop; open questions and
  pending permission requests stay open.
- RES-3: At startup every agent still `running` is marked `interrupted` and `unseen`. After a
  crash the turn kind is unknown and treated as `user`.
- RES-4: With resume on (default) each cut agent is sent one message, authored by the control
  room: `Seti restarted while you were working. Continue where you left off; check the state of
anything you had running before repeating it.` An agent that had background work is also told
  the restart stopped it.
- RES-5: Resume order: `user`, then `wake`, then `updates`, paced in small groups (`resume_pace`).
- RES-6: Not resumed: archived agents; agents waiting on a question or permission request; agents
  the user messaged first; resume off. Those not waiting on an answer are notified.
- RES-7: An agent waiting on an answer keeps its requests and reason line. The answer resumes its
  session as a message from the control room. A request cut by a restart cannot be edited and
  still times out from when it was raised.
- RES-8: Loop guard: after 3 resumes in 30 min with no finished turn, the agent is left
  `interrupted` with the resume-hold reason and audited. A turn that ends `idle` resets the count.
- RES-9: Allowing a tool call after a restart allows that one call only: a hash of tool and input
  is kept, and the agent's next identical call within `grant_ttl` runs once without a new request.
- RES-10: Lost by a restart, by design: messages queued behind the cut turn (marked removed),
  background commands and subagents, in-memory stalls, the brief.
- RES-11: Idempotent send: a `client_id` (UUID) on message, start, chat post and EA chat makes a
  repeat within `send_window` take effect once and return the first result.
- RES-12: All work on one agent is serialised.
- RES-13: Scheduled work that survives restarts (reminders, EA follow-ups, asks, inbox) lives in
  the store, not in timers.
- RES-14: Model fallback: when the runtime moves a session to a fallback model it is audited once,
  stored on the agent, routed as `active`. Switch back sends only the model command for the
  original model, after the turn ends.
- RES-15: Archive packs the agent's folders and transcript; restore puts them back; delete removes
  them. A folder is removed only when it is a real directory exactly one level below an owned
  root and no other agent uses it. No shell is used.

## 16. Audit

- AUD-1: Every change by the user, a delegate or the control room itself MUST be audited.
- AUD-2: Record: `id`, `at`, `actor`, `kind`, `subject_type`, `subject_id`, `summary`, `detail`.
- AUD-3: Actors: `user`, `agent`, `system`, `mod:<id>`. An EA action is `user` with `detail.via =
ea`; a session, identity proxy, device or unauthenticated request is marked in `via` likewise.
- AUD-4: Kinds are `<area>.<name>`; a mod's own are `mod.<id>.<kind>` and MUST be declared.
- AUD-5: Chain: `hash = SHA-256(JSON([id, at, actor, kind, subject_type, subject_id, summary,
detail, prev_hash]))`. The first event links to 64 zeros. Appends are serialised under a lock on
  the chain head.
- AUD-7: Verification walks from the anchor to the head and reports the first event whose link or
  hash fails. A read endpoint returns `{ok, checked, head_id, head_hash, broken_at, problem}`.
- AUD-8: The head MUST be written daily to a log the control room's user cannot rewrite.
- AUD-9: Pruning (after `audit_keep`) moves the anchor to the last pruned event's hash.
- AUD-10: MUST NOT appear in a record: secret or connection values; prompts' attached file
  content; direct message text; free-text question answers (length only); side-question text; mod
  command argument values and edited field values (names only); typed terminal input.
- AUD-11: Summaries and detail strings are length-bounded and pass credential redaction before
  storage.
- AUD-12: Also audited: outward calls; calls the classifier turned down; guard refusals; refused
  sign-ins (rate limited); placeholder misuse; each restart cut, resume and hold.
- AUD-13: A failed audit write MUST NOT fail the action.

## 17. Mods

| Id     | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MOD-1  | Tiers: `theme` (tokens only, no code, no capability), `bundled` (ships with the control room), `third-party` (installed by the user).                                                                                                                                                                                                                                                                                                                                                                                                     |
| MOD-2  | A manifest is read before any of the mod's code runs: `id`, `name`, `version`, `seti` (API range), `main`, `capabilities`, `activation`, `contributes`, `securitySensitive`, `defaultEnabled`, `required`. An invalid manifest, an unmet API range or an unknown contribution point keeps the mod off with a reason.                                                                                                                                                                                                                      |
| MOD-3  | Everything a mod adds is named `<mod>.<name>`; a registry key is taken once, so no mod shadows core or another mod. Turning a mod off MUST dispose all it registered and MUST NOT drop its settings or data.                                                                                                                                                                                                                                                                                                                              |
| MOD-6  | A mod acts as its own source (ACT-1); the control room supplies mod id, grants and scopes, never mod code. No mod, at any tier: runs programs; reads files beyond a grant; sees a secret; holds a reserved power; writes as the user; installs, enables or grants mods; runs another mod's command.                                                                                                                                                                                                                                       |
| MOD-8  | Capabilities, each with a scope: `tasks.read` (agents filter); `tasks.manage` (actions from `rename`, `pin`, `set_color`, `link_pr`, `unlink_pr`, `start`, `stop`); `chat.post` (`public`, `direct`); `files.read` (agents filter, path globs); `net.fetch` (hosts, HTTPS 443); `connection` (one variable and hosts, bound to a user connection at install); `storage` (own data, bounded); `notify` (own declared kinds); `agents.context` (agents filter, fixed text). Bundled only: `seti.version`, `workspaces.layout`, `tasks.ask`. |
| MOD-9  | Each operation is checked in order: size, event, grant, strict argument schema, scope. An agent outside a filter answers as if it did not exist.                                                                                                                                                                                                                                                                                                                                                                                          |
| MOD-10 | `tasks.manage` start and stop never act: they record a time-limited ask with a summary the control room writes, and only the user answers. An agent so started is sandboxed, level `self`, default credential, first message marked as the mod's.                                                                                                                                                                                                                                                                                         |
| MOD-11 | `net.fetch` and `connection`: named hosts only, no addresses, no local names, no wildcard over a public suffix; resolved addresses checked; a connection's value is added by the control room and redacted from the answer.                                                                                                                                                                                                                                                                                                               |
| MOD-12 | Third-party logic never runs in the control room's process. Each event gets a fresh engine with no network, files, environment or child processes, under `mod_limits`; its only way out is a named operation. Repeated failures turn the mod off.                                                                                                                                                                                                                                                                                         |
| MOD-14 | A third-party package is pinned by a SHA-256 over its files, stored in the database and hashed again before each start. A mismatch keeps it off and is audited.                                                                                                                                                                                                                                                                                                                                                                           |
| MOD-15 | Consent copy is written by the control room from the manifest. Install, grant, update consent, enabling a third-party or security-sensitive mod, and safe mode are the user's alone, with a fresh strong sign-in when that is required. An update that adds or widens anything (any change to a command included) waits for consent and shows only the difference; other updates apply after a delay and can be rolled back.                                                                                                              |
| MOD-17 | Third-party views run in a sandboxed frame with an opaque origin, hash-pinned scripts and no network, and reach only the mod's own commands, storage and settings through a bridge.                                                                                                                                                                                                                                                                                                                                                       |
| MOD-18 | Text from a third-party mod reaches agents and the EA only labelled as the mod's: context in `<mod_context>`, command results in `<mod_output>`, posts with author `mod`.                                                                                                                                                                                                                                                                                                                                                                 |
| MOD-19 | Commands declare callers (`palette`, `agentMenu`, `agents`, `ea`, `view`), `level` (`self`, `full`), typed arguments, `changes` and a timeout. Agents get them as `mod_<mod>_<command>`; a changing run is audited with argument names only.                                                                                                                                                                                                                                                                                              |
| MOD-20 | The EA and agents at `full` MAY turn ordinary bundled and theme mods on or off and change their settings. A `required` mod is never turned off. Safe mode holds every third-party mod off.                                                                                                                                                                                                                                                                                                                                                |
| MOD-23 | Third-party contribution points: settings, commands, slash commands, webhook sources, views, file viewers, status bar items, notification kinds, context text, themes, audit kinds, schedules, agent events (`turn_finished`, `needs_you`, `status_changed`, `pr_linked`, `pr_merged`; type, agent id and time only). Every other point is bundled only.                                                                                                                                                                                  |

## 18. Public surfaces

| Id    | Requirement                                                                                                                                                                                                                                                                    |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PUB-1 | The control room listens on loopback. A request whose `Host` is not one of its own names is refused.                                                                                                                                                                           |
| PUB-2 | Without a credential only these answer: liveness ping; the local-token exchange on loopback; sign-in and first-enrolment calls; device pairing; the pairing page; the app-association file; `POST /hooks/<id>` (signed); `GET`/`HEAD` of share links; the static client shell. |
| PUB-3 | Each public route MUST match an exact anchored path, read only the database, and be rate limited per client address (IPv6 by /64), with no shared cap others can drain.                                                                                                        |
| PUB-4 | Share link: a frozen copy of one file. Path `/share/<token>` with optional `/raw`, `/card.png`, `/p/<n>`. Token: 32 random bytes, URL-safe (43 characters); only its SHA-256 is stored; shown once.                                                                            |
| PUB-5 | Sharing is off by default. Unknown, revoked, expired and switched-off links answer the same 404. Past `share_rate` a client gets 429.                                                                                                                                          |
| PUB-7 | A share page is rendered once, at share time, with no script. Responses carry no cookie, `no-store`, `noindex`, `no-referrer`, `nosniff`, and a sandbox content policy with `default-src 'none'`. Downloads are never served as HTML or SVG.                                   |
| PUB-8 | A file is shared only after path checks, a deny list of key and credential file names, a size cap (`share_size`) and a secret scan. Expiry: 1, 7 or 30 days.                                                                                                                   |

## 19. Client contract

- API-1: Success: `{data, meta}`. Error: `{error: {title, detail}}` with an HTTP status.
- API-2: Every request body, query and path parameter MUST be validated against a schema shared by
  server and client. Failure: 400, title `Invalid request`, detail `path: message` joined by `; `.
- API-3: Statuses used: 400 invalid; 401 no credential; 403 reserved or cross-origin; 404; 409
  wrong state; 413; 415; 422 secret in an answer; 429; 503 retry.
- API-4: JSON `GET` responses carry a strong `ETag`; `If-None-Match` (weak comparison) answers 304. The API is `no-store`.
- API-5: State without a stream (agents, attention, requests, workspaces, PRs) is polled with
  conditional requests. Polling pauses while hidden or offline and fires at once on return.
- API-6: Streams are server-sent events with a keepalive every `sse_keepalive`. The agent stream
  resumes from a cursor (`after` or `Last-Event-ID`); a gap too large sends a fresh backlog.
- API-7: Lenient reads: a client MUST fail only on a wrong outer shape. A bad field takes a
  default, a bad list item is dropped, an unknown enum value takes a safe default (`idle` for
  status), and each repair is reported.
  Why: an older client must survive a newer server.
- API-8: Writes need a JSON content type and, for browser sessions, the control room's own
  `Origin`. Bodies are limited to `body_max` except uploads.
- API-9: Auth, any one of: local token (`Authorization: Bearer`, loopback only); passkey session
  (HttpOnly, SameSite cookie; idle and absolute lifetimes, `session_life`; user verification
  required); an identity proxy's signed assertion, verified by the control room; a paired device
  proof.
- API-10: First passkey: from a browser already let in, or a single-use, short-lived setup code
  printed on the host. Sign-in, setup and pairing attempts are rate limited per client.
- API-11: Pairing: a single-use code (128 bits, valid `pair_ttl`); the device posts `{code, name,
platform, public_key}` (P-256) and gets `{device_id, scopes}`.
- API-12: Device proof: `Authorization: SetiDevice <JWS>`; header `{alg: ES256, typ:
seti-device+jwt, kid: device_id}`; claims `{htm, htu, iat, jti}`; `iat` within 60 s; `jti`
  single use. A refused proof answers 401 and MUST NOT fall back to another credential.
- API-13: Device scope `widget` reaches one read-only summary: agents that need the user with
  reason lines, a few agents with status, counts, today's cost; redacted, no transcript.
- API-15: A client that cannot reach the server keeps the data it holds and shows no error until
  an answer arrives. When a view fails to load after a deploy, the client reloads once per build,
  only if the server answers and no form has unsaved changes; else it offers a reload.
- API-17: Every flow, full configuration included, MUST work on a phone-sized client.

## 20. Conformance

### 20.1 Core

An implementation is SETI-compatible when it meets all of:

1. Agent state and derived status: ENT-1 to ENT-6, ENT-13 to ENT-16, ENT-20 to ENT-22.
2. Turn lifecycle: TURN-1 to TURN-8, TURN-11 to TURN-14, TURN-18.
3. Update delivery: UPD-1 to UPD-8, UPD-11, UPD-13.
4. Attention: ATT-1 to ATT-11, ATT-14 to ATT-19, ATT-21, ATT-24, ATT-25.
5. Actors and reserved powers: ACT-1 to ACT-6.
6. Permission requests with timeout: PERM-1 to PERM-9; guards GRD-1, GRD-4, GRD-6.
7. Questions and levels: LVL-1 to LVL-5, LVL-8 to LVL-14.
8. Resilience: RES-1 to RES-9, RES-11, RES-12.
9. Audit chain: AUD-1 to AUD-13.
10. Client contract: API-1 to API-9.

### 20.2 Profiles

| Profile       | Adds                                                                        |
| ------------- | --------------------------------------------------------------------------- |
| Sandbox       | all SBX, EGR, HST, CAP, SEC and CHG; PERM-10; GRD-2, GRD-3, GRD-7 to GRD-10 |
| Shared tools  | all TOOL (requires Sandbox)                                                 |
| Events        | all CHN; PUB-2 (hooks)                                                      |
| Pull requests | all PR                                                                      |
| Team          | all CHAT                                                                    |
| Assistant     | all EA; LVL-6; ATT-12                                                       |
| Mods          | all MOD                                                                     |
| Sharing       | PUB-4 to PUB-8                                                              |
| Devices       | API-11 to API-13                                                            |

An implementation without the Sandbox profile MUST NOT claim that agents are untrusted, and MUST
treat every agent as holding the user's access.

## 21. Security considerations

- The API runs commands as its user. Whoever drives it owns the host; hence ACT-2, PUB-1 and
  API-9.
- The sandbox is the boundary for agents. Permission rules and the classifier are not; they bind
  the runtime's tools, not what a shell command can do.
- The egress proxy cannot read tunnelled traffic or request bodies. A placeholder sent in a body,
  or to an allowlisted host the proxy does not terminate, is not detected; it is still only a
  placeholder.
- A webhook delivery that carries its secret as a bearer token proves the sender but not the body.
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
- Push payloads carry reason lines and closing lines; they are redacted (SEC-9) but leave the
  host.

## 22. Work in progress (non-normative)

- Multi-node: a control plane with remote nodes that run agent sessions. Affects ENT-13, SBX,
  CAP, RES-1 to RES-5.
- Repository registry removal: agents clone for themselves (TURN-9); remaining registry fields on
  the agent and repo tools at `full` will go. PR-1 already needs no registry.
- Attention: needs-you falling back to a push when no page has focus (ATT-10), the mute covering
  every brief line (ATT-25), watched agents keeping urgency (ATT-11), and the stall clock
  excluding open questions (ATT-5).
- Public paths for mods: declared, not available.
- Third-party mod install stays behind a developer switch until its runtime is reviewed.
- Native device clients beyond the `widget` scope.

## Appendix A. Reference constants

Values the reference implementation uses for the named constants. An implementation MAY choose
others.

| Requirement                    | Constant: reference value                                                                                                                                                                                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ENT-14, TURN-3                 | `idle_close`: 15 min. `interrupt_grace`: 5 s.                                                                                                                                                                                                                                         |
| UPD-5, UPD-7                   | `wake_debounce`: 5 s. `wake_max`: 30 s. `batch_updates`: 20. `update_body`: 6000.                                                                                                                                                                                                     |
| UPD-8                          | `auto_turns`: 20. `auto_window`: 60 min.                                                                                                                                                                                                                                              |
| ATT-5                          | `stall_after`: 20 min. `stall_check`: 1 min.                                                                                                                                                                                                                                          |
| ATT-9                          | `push_cap`: 5. `push_window`: 10 min.                                                                                                                                                                                                                                                 |
| ATT-17, ATT-23, ATT-24         | `focus_ttl`: 45 s. `focus_report`: 20 s. `call_ttl`: 15 s. `away_after`: 5 min.                                                                                                                                                                                                       |
| ATT-21, ATT-25                 | `ask_remind`: 15 min. `brief_needs`: 5. `brief_changes`: 6.                                                                                                                                                                                                                           |
| CHG-3                          | `chg_pending`: 5. `chg_hourly`: 10. `chg_expiry`: 24 h.                                                                                                                                                                                                                               |
| CAP-1                          | `mem_cap`: 30% of host RAM in whole GB, 6 to 16 GB. `cpu_cap`: 3 cores at half the control room's weight.                                                                                                                                                                             |
| TOOL-2, TOOL-4, TOOL-10        | `tool_schema`: 30 properties, depth 4, 8 KB; description 20 to 1500; timeout 1 to 600 s (default 120); 5 needs of 1 to 5 hosts. `tool_script`: 64 KB. `tool_output`: 256 KB.                                                                                                          |
| CHN-2, CHN-9                   | Event `title` 200, `detail` 2000, `kind` 80. `hook_replay`: 24 h. `hook_limits`: body 256 KB; 60 per minute per channel; 600 per minute overall.                                                                                                                                      |
| CHN-12, CHN-14                 | `poller_limits`: interval 1 min to 1 day (default 5 min); timeout 5 to 120 s (default 30); compute 1 s without awaiting, 10 s per run; memory 48 MB; 500 items; output 1 MB; state 16 KB; 3 runs at once, one per poller; 20 requests per run, 5 redirects, 4 MB each, 12 MB per run. |
| CHN-18, CHN-30                 | `poller_backoff`: 6 h. `fail_streak`: 5 for a poller, 3 for a reminder. `route_retry`: 30 s to 1 h, 12 attempts.                                                                                                                                                                      |
| CHN-20, CHN-22, CHN-25, CHN-29 | `reminder_limits`: interval 1 min to 7 days; 5 s; 256 MB; message 2000; state 16 KB. `cron_catchup`: 1 h. Subscription `events`: 20 kinds. Log excerpt: 1000.                                                                                                                         |
| PR-2, PR-4, PR-6, PR-9         | Create request: 50 links. `pr_poll`: 60 s. Clock skew: 5 s. `subagent_wait`: 30 min.                                                                                                                                                                                                  |
| CHAT-1, CHAT-3, CHAT-5         | Message text: 4000. Active agent: running, open session, or updated within 12 h. `chat_burst`: 12 in 15 min. `chat_loop`: 6 in 15 min.                                                                                                                                                |
| LVL-10, LVL-15                 | Answer batch: 100 items. `notes_waiting`: 10. Index: 1500 characters. `note_stale`: 3 failed checks in a row; unverified 30 days (fact, environment) or 90 days (how-to, gotcha).                                                                                                     |
| EA-4, EA-10, EA-13             | `ask_ttl`: 10 min. `settle`: quiet for 45 s, at most 3 min. `call_silence`: 30 s. `wake_phrase`: 2 to 40 characters, at most 4 words. `keep_awake_seconds`: 5 to 600.                                                                                                                 |
| RES-1, RES-5, RES-9, RES-11    | `stop_grace`: 7 s. `resume_pace`: 3 starts 2 s apart, 20 s between groups. `grant_ttl`: 15 min. `send_window`: 24 h.                                                                                                                                                                  |
| AUD-9, AUD-11                  | `audit_keep`: 365 days. Summary: 300. Detail string: 500.                                                                                                                                                                                                                             |
| MOD-8, MOD-10, MOD-12          | Storage: 64 KB a value, 1 MB a mod. Ask: 10 min, 3 open per mod. `mod_limits`: memory 32 MB; compute 5 s; wall 10 s (schedule 30 s); 50 calls; 10 fetches; queue 20 per mod; 60 events per minute; 20 failures an hour turn the mod off.                                              |
| MOD-15, MOD-19, MOD-23         | Update delay: 24 h. Command timeout: 1 to 600 s. Schedule: 5 min to 1 day.                                                                                                                                                                                                            |
| PUB-4, PUB-5, PUB-8            | Preview pages: 1 to 50. `share_rate` per client per minute: 30 misses, 120 pages or downloads, 600 images. `share_size`: 10 MB.                                                                                                                                                       |
| API-6, API-8, API-9            | `sse_keepalive`: 15 s. `body_max`: 8 MB. `session_life`: idle 7 days, absolute 30 days.                                                                                                                                                                                               |
| API-10, API-11, API-15         | Setup code: 15 min. Attempts per 10 min: 20 sign-in, 20 setup, 10 pairing. `pair_ttl`: 5 min. Stale-client reload: once per build and per minute.                                                                                                                                     |

## Appendix B. Retired identifiers

A retired identifier's text now lives in the requirement named, unless marked removed.

| Now in                         | Retired                                                                  |
| ------------------------------ | ------------------------------------------------------------------------ |
| UPD-1                          | ENT-9                                                                    |
| ENT-11, ENT-17                 | ENT-12; ENT-18                                                           |
| TURN-1, TURN-12                | TURN-2; TURN-13                                                          |
| UPD-11                         | UPD-12                                                                   |
| ATT-5, ATT-25                  | ATT-6; ATT-26                                                            |
| SBX-2                          | SBX-5                                                                    |
| EGR-2, EGR-8                   | EGR-3; EGR-9                                                             |
| PERM-2, PERM-10                | PERM-3; PERM-11                                                          |
| GRD-4, GRD-7, GRD-10           | GRD-5; GRD-9; GRD-11                                                     |
| CHG-5, HST-2, CAP-2            | CHG-6; HST-3; CAP-3                                                      |
| SEC-2, SEC-5, SEC-11           | SEC-3; SEC-6; SEC-12                                                     |
| TOOL-2, TOOL-1, TOOL-10        | TOOL-3; TOOL-9; TOOL-11                                                  |
| CHN-2, CHN-4, CHN-7, CHN-9     | CHN-3; CHN-5; CHN-8; CHN-10                                              |
| CHN-12, CHN-14                 | CHN-13, CHN-16; CHN-15                                                   |
| CHN-20, CHN-22, CHN-18, CHN-27 | CHN-21; CHN-23; CHN-24; CHN-28                                           |
| PR-2                           | PR-3                                                                     |
| CHAT-1, CHAT-3, CHAT-6         | CHAT-2; CHAT-4; CHAT-7                                                   |
| LVL-6, LVL-8, LVL-11           | LVL-7; LVL-9; LVL-12                                                     |
| EA-3, EA-10                    | EA-5; EA-11                                                              |
| RES-1, AUD-5                   | RES-2; AUD-6                                                             |
| MOD-3, MOD-2, MOD-6, MOD-12    | MOD-4; MOD-5; MOD-7; MOD-13                                              |
| MOD-15, MOD-20, MOD-23         | MOD-16; MOD-21; MOD-24                                                   |
| PUB-5, PUB-3                   | PUB-6; PUB-9                                                             |
| API-10, API-15                 | API-14; API-16                                                           |
| removed                        | EA-14 (the assistant's tool cap); MOD-22 (import rules for bundled mods) |

## Appendix C. Source map

Where the reference implementation keeps each section, for contributors.

| Section             | Source                                                                                                                                                                                                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3 Entities          | `shared/src/tasks.ts`, `inputs.ts`, `subtasks.ts`, `workspaces.ts`, `requests.ts`, `permissions.ts`, `questions.ts`, `change-requests.ts`; `server/src/db.ts`, `subtasks.ts`, `routes/archive.ts`                                                                                                 |
| 4 Turns             | `server/src/runner.ts`, `agent-session.ts`, `input-queue.ts`, `send-check.ts`, `queued-removal.ts`, `dropped-prompt.ts`, `session-restart.ts`, `rewind.ts`, `turn-asking.ts`, `task-location.ts`, `tasks.ts`; `shared/src/prose-question.ts`                                                      |
| 5 Updates           | `shared/src/channel-delivery.ts`; `server/src/inputs.ts`, `input-preface.ts`, `turn-prompt.ts`, `store/inputs.ts`, `agent-waits.ts`                                                                                                                                                               |
| 6 Attention         | `shared/src/attention.ts`, `notifications.ts`; `server/src/ea-attention.ts`, `ea-deliver.ts`, `task-blocked.ts`, `stall-watch.ts`, `task-attention.ts`, `notifications.ts`, `notify-scope.ts`, `presence.ts`, `attention-brief.ts`, `asking-reminder.ts`, `closing-line.ts`, `needs-you-count.ts` |
| 7.1 Actors          | `server/src/access.ts`, `ea-guard.ts`, `local-auth.ts`                                                                                                                                                                                                                                            |
| 7.2 Sandbox         | `server/src/sandbox-mounts.ts`, `task-sandbox.ts`, `sandbox.ts`, `sandbox-git.ts`, `agent-start.ts`, `agent-cap.ts`                                                                                                                                                                               |
| 7.3 Egress          | `server/src/egress-proxy.ts`, `egress-hosts.ts`, `egress-placeholders.ts`, `egress-rules.ts`, `egress-replay.ts`, `egress-aws.ts`, `token-minter.ts`, `github-token.ts`, `ssh-config.ts`, `sandbox-ca.ts`                                                                                         |
| 7.4 Permissions     | `shared/src/permissions.ts`, `permission-timeout.ts`; `server/src/permission-policy.ts`, `permission-requests.ts`, `permission-rules.ts`, `permission-timeout.ts`, `bypass.ts`, `bypass-mode.ts`                                                                                                  |
| 7.5 Guards          | `server/src/permission-guard.ts`, `protected-writes.ts`, `repeat-guard.ts`, `repeat-hooks.ts`, `review-hooks.ts`, `review-coverage.ts`, `permission-edits.ts`, `outward.ts`                                                                                                                       |
| 7.6 Change requests | `shared/src/change-requests.ts`; `server/src/change-requests.ts`, `key-requests.ts`, `change-request-notes.ts`, `routes/change-requests.ts`                                                                                                                                                       |
| 7.7 Hostile repos   | `server/src/git.ts`, `probe-launch.ts`, `sandbox-mounts.ts`, `html-preview.ts`                                                                                                                                                                                                                    |
| 7.8 Caps            | `shared/src/memory.ts`, `cpu.ts`; `server/src/memory-scope.ts`, `oom-guard.ts`, `memory-notes.ts`, `cpu-cap.ts`                                                                                                                                                                                   |
| 8 Secrets           | `shared/src/connections.ts`, `credentials.ts`, `secrets.ts`, `connection-templates.ts`; `server/src/secret-box.ts`, `secrets.ts`, `connections.ts`, `scrub.ts`, `secret-questions.ts`, `secret-delivery.ts`                                                                                       |
| 9 Shared tools      | `shared/src/shared-tools.ts`; `server/src/shared-tool-proposals.ts`, `shared-tool-files.ts`, `shared-tools.ts`, `shared-tool-server.ts`                                                                                                                                                           |
| 10 Events           | `shared/src/channels.ts`, `pollers.ts`, `reminders.ts`; `server/src/channels/`, `pollers/`, `reminders/`, `store/channels.ts`, `store/channel-routing.ts`, `routes/hooks.ts`                                                                                                                      |
| 11 PRs              | `shared/src/prs.ts`, `pr-fix-ci.ts`; `server/src/pr-inputs.ts`, `pr-events.ts`, `pr-self.ts`, `pr-link.ts`, `pr-evidence.ts`, `pr-ended.ts`, `pr-list.ts`, `pr-details.ts`, `github-list.ts`, `github-checks.ts`                                                                                  |
| 12 Chat             | `shared/src/team.ts`; `server/src/team.ts`, `store/team.ts`, `direct-privacy.ts`, `workspace/chat.ts`, `side-chat/`                                                                                                                                                                               |
| 13 Tools            | `shared/src/seti-control.ts`, `questions.ts`, `knowledge.ts`; `server/src/seti-tools/`, `questions.ts`, `question-answers.ts`, `house-rules.ts`, `knowledge.ts`, `knowledge-index.ts`                                                                                                             |
| 14 Assistant        | `ea/src/seti_ea/` (`gate.py`, `asks.py`, `inbox.py`, `settle.py`, `held.py`, `promises.py`, `think.py`); `shared/src/ea.ts`, `ea-replies.ts`; `server/src/routes/ea-state.ts`, `ea-asks.ts`, `ea-inbox.ts`, `ea-watch.ts`                                                                         |
| 15 Resilience       | `server/src/restart-cut.ts`, `restart-resume.ts`, `restart-waits.ts`, `permission-grants.ts`, `client-sends.ts`, `task-lane.ts`, `model-fallback.ts`, `archive.ts`, `archive-files.ts`, `owned-dirs.ts`, `retention.ts`                                                                           |
| 16 Audit            | `shared/src/audit.ts`; `server/src/audit.ts`, `store/audit.ts`, `scrub.ts`, `routes/audit.ts`                                                                                                                                                                                                     |
| 17 Mods             | `shared/src/mods.ts`, `mod-contributions.ts`, `mod-runtime.ts`, `mod-scopes.ts`, `mod-diff.ts`, `mod-third-party.ts`, `mod-bridge.ts`; `server/src/mods/`; `packages/mod-api/`                                                                                                                    |
| 18 Public           | `server/src/access.ts`, `share-path.ts`, `routes/share-public.ts`, `shares.ts`, `rate-limit.ts`, `security-headers.ts`                                                                                                                                                                            |
| 19 Client           | `server/src/http.ts`, `etag.ts`, `app.ts`, `seti-auth.ts`, `passkeys.ts`, `devices.ts`, `routes/stream.ts`; `shared/src/lenient.ts`, `devices.ts`, `auth.ts`; `ui/src/lib/poll-loop.ts`, `reach.ts`, `stale-build.ts`, `event-stream.ts`                                                          |
