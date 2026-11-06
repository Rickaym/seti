# Security

TLDR: anyone who can drive Seti's API can run commands as the Seti user, so the API answers only
its owner. Service secrets are key files, one owner-only file each; tokens and connection values
set in the UI are sealed in PostgreSQL under a key that is itself a key file. Keep that key and the
backup
private key off the host. The sandbox model is in [Architecture](architecture.md).

## Who can reach the API

- Seti listens on `127.0.0.1` and refuses requests whose `Host` is not a loopback Seti name.
- Loopback API calls need a local token, as `Authorization: Bearer <token>` or the HttpOnly cookie
  the sign-in page sets, or a passkey session. Only `/api/ping` and the sign-in calls answer
  without one. The local token always works on loopback, so it is the way back in.
- Seti signs browsers in with passkeys (WebAuthn, user verification required). A sign-in gives an
  opaque random session id in an HttpOnly, SameSite=Lax cookie, `__Host-` prefixed and Secure on
  the public hostname. Sessions end after `SETI_AUTH_IDLE_DAYS` without a request (7) and after
  `SETI_AUTH_MAX_DAYS` in any case (30); Settings, Sign-in lists and signs them out. Each sign-in
  replaces the browser's previous session. Writes a session authenticates must carry Seti's own
  `Origin`. Sign-in and setup attempts are rate limited per client (an IPv6 client by its /64),
  with no shared cap that others could drain. Each sign-in, enrollment and sign-out is in the
  audit log, and so are refusals, up to 20 per client per 10 minutes, marked `via: anonymous`.
- The first passkey is enrolled by a browser already let in (local token or Cloudflare Access) or
  with a one-time setup code that `pnpm setup-code` prints on the host (single use, 15 minutes).
- The public hostname can sit behind Cloudflare Access. Seti verifies the Access JWT itself and
  admits only `SETI_ACCESS_EMAILS` when set. With Require passkey on (Settings, Sign-in), Access
  alone no longer lets a request in; it can only be turned on once a passkey for the public
  hostname exists, and its last such passkey cannot be removed while it is on. Without Access
  settings the public hostname takes passkey sessions only.
- Phones pair in Settings, Sign-in. Pair phone shows a one-time code (128 random bits, single
  use, 5 minutes) as text and as the QR code of `https://<host>/pair#code=<code>`; the fragment
  never reaches the server, and `/pair` only tells the user to open the app. The app posts
  `{code, name, platform, public_key}` to `/api/devices/pair`, where `public_key` is the SPKI DER
  (base64url) of an EC P-256 key it keeps non-exportable in the Android Keystore, and gets
  `{device_id, scopes}` back.
- Every device request carries `Authorization: SetiDevice <proof>`: a compact JWS signed with that
  key, header `{alg: 'ES256', typ: 'seti-device+jwt', kid: <device_id>}`, claims
  `{htm, htu, iat, jti}`. `htu` is scheme, host and path without the query. Seti checks the
  signature against the stored key, that `iat` is within 60 seconds of its clock, that `jti` (16
  to 128 base64url characters) was never used by that device (Redis, with an in-memory fallback),
  and that the device is not revoked. A refused proof gets 401 and never falls back to another
  credential. Refused proofs and pairings are audited like refused sign-ins.
- The `widget` scope, the only one, reaches `GET /api/widget/summary`, read-only: up to 8 agents
  that need the user with the reason line their notifications show, up to 8 agents with their todo
  step or status line, the name of the tool in use, up to 3 running subagents and their PR's state,
  counts of running and idle agents, and today's cost. Titles and lines are cut short and redacted
  on the server; the summary carries no tool input beyond the reason line, no transcript and no
  file content. With **Names** off for the device, which only the user changes in Settings, the
  summary replaces titles and free text with generic labels. A device reaches nothing else.
- `/.well-known/assetlinks.json` lists the official Android app, built into Seti as
  `OFFICIAL_ANDROID_APP`, for its web view and passkey sharing. A self-built app set in Settings,
  Devices (or `SETI_ANDROID_PACKAGE` and `SETI_ANDROID_CERT_SHA256`) joins it, and
  replaces it only when that setting says so.
- `/hooks/<id>` and share links are the only paths without Access or a token: each webhook has an
  unguessable id and its own signing secret, and every delivery must be signed. Share links are
  described below.
- The EA answers only calls that carry its token, apart from `/health`.
- A question the EA asks before a destructive tool acts lives in `ea_ask` with the exact call.
  Only the EA bot records questions and reports the user's typed or spoken yes
  (`/api/ea/asks/confirm`), and Seti takes a yes only for an open question asked in an earlier
  user turn or an earlier EA process, within ten minutes. Allow and Deny in a notification
  (`/api/ea/asks/:id/decision`) refuse the EA and agents' Seti tools; each question takes one
  answer, and the EA runs an allowed call once, with the arguments it recorded.
- The since-you-left brief lives in the server's memory only and quotes agents' closing lines and
  reason lines, which are redacted when stored. Every page reads it with `GET /api/attention`;
  only the EA bot takes it for a call with `GET /api/ea/brief`, and only the bot's inbox poll
  marks a call live. Where each attention tier reaches the user is a notification setting, not a
  security setting: the EA and agents at Full change it through `set_notifications`, audited with
  their actor, and urgent cannot be set below a toast.
- Seti control is a per-agent level that only the user changes: Off, Self (the default) or Full.
  It decides which `seti` MCP tools the agent gets; they run inside the server as that agent, so no
  token enters its sandbox, and the audit log names the agent as actor. Off leaves its status line
  and file handoffs. Self adds tools that read Seti (context packs, CLAUDE.md files, channels,
  repos, MCP servers, plugins, caps and the sandbox policy) and change only the agent itself (its
  title, colour, pin, update mode, repos, directories, PRs, packs, role, group chat handle and
  channel subscriptions). Full gives the EA's Seti actions. At no level do they change access,
  sandbox, credentials, connections, SSH, memory or CPU caps or Seti control of any agent; Full
  never stops, archives or restarts the calling agent, and starts agents with at most the
  caller's access and Seti control Self.
- Self is enforced per call, not only by the tool list. Each call checks the level the agent has
  then and refuses a tool beyond it; Self tools take no argument naming an agent, so Seti fills in
  the caller; a reference to another agent is refused without saying which agents exist; and the
  core functions behind the Self tools refuse another agent's task and shared writes, such as a
  new or changed context pack or CLAUDE.md file, for a Self caller (`refuseOtherAgent` and
  `refuseAtSelf` in `server/src/ea-guard.ts`). Edits an agent makes to the pack and CLAUDE.md
  files in its workspace run as that agent too, so below Full Seti puts the shared text back with
  a note and applies only the `linked:` line.
- Only the user writes an agent's prompts. `POST /api/tasks/<id>/messages` refuses the EA and
  agents' seti tools with 403 in the core function (`refusePromptAsUser` in
  `server/src/ea-guard.ts`), and neither has a tool for it. The EA and agents reach an agent
  through the group chat, which reaches its transcript as an update marked with who wrote it, and
  starts its turn without user text. A new agent's first message written by the EA or another
  agent carries who wrote it, which the agent is told and the transcript shows.
- The EA and agents at Full may retry another agent's turn (`retry_agent_turn`, and
  `POST /api/tasks/<id>/retry` for the EA), because a retry takes no text: `retryTask` sends the
  agent's stored last message again with its attachments, and refuses with 409 when there is none
  or a turn is running. A first message the EA or an agent wrote goes again with its mark, so the
  agent is told again who wrote it; nothing goes out in the user's name that the user did not
  write. An agent never retries its own turn, and at Self reaches no other agent's. The audit log
  records the retry as the EA or the agent that asked, with `retry: true`.
- A group chat message can be direct, to one agent or the EA. Only its author, its recipient and
  the user see it: the user's chat shows every direct message with a lock and its recipient, and a
  switch hides them. Other agents never see it in `chat.md`, their seti tool reads or searches, and
  the live context the EA and agents share leaves out every direct message. The audit log records
  that a direct message was sent, by whom, to whom and its length, never its text, and so does
  the outward record of an agent's `post_team_chat` call with `to`. The text lands in both
  parties' transcripts, and every read of a transcript by the EA or an agent's seti tools
  (pages, single messages, digests, history windows, subagent pages and searches) shows `[direct message hidden]` in its place unless the reader sent or got it, in
  `hideDirect` (`server/src/direct-privacy.ts`). That covers the recipient's update, the sender's
  `post_team_chat` call and result, an agent's group chat reads and its `chat.md` appends and
  reads. A hidden message never matches a search, the EA search index leaves direct messages out,
  the EA cannot open an agent's `chat.md` or follow its transcript live, and a side question to an
  agent that holds direct messages the asker is not part of is refused. The user's own views show
  everything.
- Agents at Self or Full propose security changes they need with `request_change`; nothing else
  applies them. A request names the exact change and the agent's reason: a host and port for the
  network allowlist (443 unless it names one), a connection's variable and hosts, or an MCP server
  Seti already has. Hosts on this machine or its networks (localhost, loopback, private and
  link-local addresses) and wildcards over a top-level domain or any other public suffix, such as
  `*.co.uk` or `*.github.io`, are refused outright, and a
  wildcard or an address shows a warning on the card. The sandbox, Bypass, permission modes and
  rules, other security settings, secret values and other agents are never requestable. One
  identical request waits per agent, at most 5 wait at once and 10 are made an hour, and each
  expires after a day.
- A request waits in the agent's permission area, in Needs you with its reason line, and as a
  push. Allow and Deny post to `/api/tasks/<id>/change-requests/<request>`, which refuses the EA
  and agents' Seti tools (`refuseAgent` in the core function too). Allow applies the change as
  the user: a host joins this agent's own allowlist (the default, kept in `task_allowed_host`
  and read by its egress proxy on every connection) or, when the user picks All agents, the
  shared one. A connection request adds a connection with that variable and those hosts to the
  agent's credential. Its card has a masked key box, so the user can paste the key and allow in
  one step; the key is optional, and without it the user pastes it later in Settings, Connections,
  while the proxy has nothing to swap in. A connection that already has the variable joins only on
  the same hosts and takes a pasted key only while it has none. The pasted key travels only in the
  user's own Allow to the route above, which checks it with the same schema as Settings,
  Connections and seals it through the same `setConnectionValue`; it never enters the request,
  the agent's update, the transcript, events or an error. The agent then gets an update saying how
  it ended and whether the key is in place, never a value or its length. The audit log records
  the request as the agent's, the answer as the user's, and a pasted key only as the connection's
  value being set. An agent's own hosts show in its access, where the user removes them.
- Poller scripts run in a WebAssembly engine inside the server with no Node APIs. Their fetch
  reaches only allowlisted hosts on public addresses, and the connections a poller may send are
  filled in by Seti and replaced with `[secret]` in everything the script, its logs and its events
  see. Only the user gives a poller extra hosts or connections (see [Pollers](pollers.md)).

## Agent files

The Files view reads an agent's working directory, repos, extra directories and Seti workspace, and
nothing else. Every path resolves through its symlinks and must stay inside its root; the sandbox's
hidden paths, Claude Code's data and Seti's own data outside the agent's worktree and workspace are
refused, and dot files open only when asked for. The user can save text files but not delete or
rename them, each save must name the content it replaces and is audited without its text, and the
EA can read but not save.

The EA reads an agent's files through these same routes, with two more limits enforced on the
server (`server/src/ea-files.ts`): files whose names mark keys, credentials or env files, the list
shares refuse, are refused, and credentials inside any text it reads or searches come back
redacted. An agent hands the EA a file with `send_file` to `ea`: Seti checks it as for any handoff
(inside the sender's folders, not hidden, within the size cap, not a key or credential file),
copies nothing, and sends the EA a direct message naming its real path, which the EA reads whole
up to 30,000 characters and says when it clipped.

HTML files up to 20 MB open as a rendered preview, with their source one toggle away. An agent
writes that HTML, and Seti's API runs commands as its user, so the page must never run on Seti's
origin; and the user's browser is not held to the agent's egress allowlist, so the page must not
reach the network either, or it could carry workspace data past that allowlist. The raw route
serves a preview (`?preview=1`) only for a text file whose extension a running bundled mod's `page`
viewer claims (`.html` and `.htm`, while the HTML preview mod is on; any other file answers 403),
only to a frame (`Sec-Fetch-Dest` `iframe`, else 403), inline, with `nosniff`, `Referrer-Policy: no-referrer` and this policy:

```text
default-src 'none'; script-src 'none'; style-src 'unsafe-inline' data:; img-src data: blob:;
font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; form-action 'none';
base-uri 'none'; frame-ancestors 'self'; sandbox
```

The viewer frames it with `sandbox=""` and `referrerpolicy="no-referrer"`. The policy's own
`sandbox` gives the page an opaque origin even if its address is opened elsewhere, so it cannot
read Seti's cookies or storage, reach its parent, or call the API as the user. Inline styles run,
and images, fonts and media load from `data:` and `blob:` only; every script, style, image or
link aimed at the web is refused in the browser, and the viewer says so above the frame. The page
gets no forms, popups, downloads, modal dialogs or top navigation, and Seti's own `frame-src`
keeps the frame from navigating anywhere but Seti.

Scripts start off. The Scripts switch in the viewer header turns them on for that file until the
page reloads, and Seti stores nothing. Only then does the request carry `scripts=1`, the policy
read `script-src 'unsafe-inline' data: blob:` and `sandbox allow-scripts`, and the frame
`sandbox="allow-scripts"`. Inline scripts then run, still with no fetch, beacon or socket to
anywhere. The opaque origin refuses `localStorage` and `sessionStorage`, which many pages read as
they load, so with scripts on Seti adds a short inline script after the doctype that gives the
page in-memory stores in their place: they last one load, and nothing in them reaches Seti or the
disk. One channel stays open to them, which is why they start off: a script can start a
WebRTC peer connection, whose ICE traffic reaches a STUN or TURN server the page names, since no
browser lets a page policy block WebRTC yet. Previews still need the user's sign-in, and share
links never render HTML.

The preview exists only while the HTML preview mod is on. It is on by default and marked
`securitySensitive`, so only the user turns it on or off, never the EA or an agent. With it off, HTML
files open as source text and every `?preview=1` request answers 403. The policy, the frame-only
check and the storage shim above are Seti's own, in `server/src/html-preview.ts`, and hold
whichever mod asks for a page.

Files and long pastes the user attaches to a message stream to a staging folder in Seti's data,
outside every sandbox, capped at 25 MB a file and 50 MB a message, and are typed by their content.
Sending the message moves them into the agent's workspace under `uploads/` with a cleaned name that
never replaces a file; a link the agent planted in its place is replaced, never followed. The
audit log records their names, types and sizes, never their content, and unsent ones expire after a
day.

## Share links

The user can publish a frozen copy of one file through `/share/<token>`, readable by anyone with the
link. Sharing is a switch in Settings, Sharing, off by default; while it is off no link is made and
every link answers 404. Only the user shares: the EA, agents' Seti tools and paired devices are
refused on every share route, and none of them has a tool for it.

- A share goes through the Files rules (its real path inside the agent's root, hidden paths and
  Seti's data refused, no dot files), then a deny list of key, credential, env and signing files
  on every path segment, a 10 MB cap that a Markdown file's images count toward, and the secret
  scan. A finding refuses the share with its line numbers and kinds, never the values, unless the
  user shares anyway; the share records that.
- The token is 32 random bytes. Seti stores its SHA-256 and shows the link once; New link replaces
  it. Update copies the file again under the same link, and only while the path still leads to the
  same real file. Revoke, expiry (1, 7 or 30 days) and the agent's deletion end a share and drop
  its copy. Every change is audited.
- The Access guard lets through only GET and HEAD of exactly `/share/<43 characters>`, its `/raw`
  download, its stored preview images `/p/1` to `/p/50` and its link card `/card.png`. That
  handler reads the share tables and nothing else, never the file system or a converter, answers
  unknown, ended and switched-off links with the same 404, and returns 429 to a client after 30
  misses, 120 page or download requests, or 600 image requests a minute. Views are counted with
  Cloudflare's country and a clipped user agent; fetches by link preview bots (Slack, WhatsApp,
  Facebook, X, Discord, Telegram, LinkedIn and others, by user agent) count as link previews. A
  page view and a plain download count; the byte range requests a player makes do not.
- The download answers one byte range (`bytes=a-b`, `bytes=a-`, `bytes=-n`) with 206, reading
  only that slice from the database, and a range past the end with 416. Several ranges, a header
  that does not parse and any `If-Range` get the whole file.
- A page is rendered once, when the file is shared or updated, with no script: Markdown up to 1 MB
  with raw HTML shown as text and links only to the web and mail; PDFs as page images (the first
  50), each under a transparent, selectable copy of its text lines, placed from the boxes poppler
  prints and read by a strict parser that takes only page, line and word tags and checked numbers;
  SVG as a picture with its source; CSV and TSV as a table of the first 1,000 rows and 50 columns;
  JSON, YAML and TOML indented and highlighted; code highlighted; notebooks with their outputs as
  text and images, never as HTML or script; zip and tar archives as a listing; Word, Excel,
  PowerPoint and OpenDocument files as the pages LibreOffice prints them to, then as a PDF; audio
  and video in the browser's own player, with a poster frame, when the container and codecs play in
  every browser (MP4 with H.264 and AAC, WebM, MP3, WAV, Ogg, FLAC, M4A), else the poster, length
  and download; other text numbered. Every image the page shows is stored with it and served from
  its image path; the page itself is at most 4 MB and its images 20 MB.
- PDFs, Office files, audio, video, SVGs, link cards and BMP, TIFF, AVIF and ICO images go through
  poppler, LibreOffice, ffprobe, ffmpeg and resvg, which parse the file, so each run is sandboxed:
  bwrap with every namespace unshared (no network), no capabilities, `/usr` and the font and
  linker configuration read-only (LibreOffice also gets its registry under `/etc/libreoffice`), no
  home directory, a read-only copy of the input and an empty output folder; prlimit caps memory
  (512 MB to 1.5 GB), CPU time, file size and open files; a wall-clock timeout kills the run's
  process group; its output is capped; at most two run at once, at low priority. LibreOffice starts
  from a fresh profile in a sized private `/tmp` with macros disabled and Java off, and a
  conversion never runs document macros. A failed run leaves the page with the source or the
  download and a message, and never runs outside the sandbox.
- Every response under `/share` carries `nosniff`, `no-referrer`, `noindex`, `no-store`, no
  cookie and this policy: `sandbox allow-downloads; default-src 'none'; img-src 'none';
style-src 'unsafe-inline'`. A page's policy allows images from its own image path alone
  (`img-src https://<host>/share/<token>/p/`), since the sandbox gives it no origin of its own;
  an audio or video page's policy also allows media from its own download alone
  (`media-src https://<host>/share/<token>/raw`). Preview images, the card and an audio or video
  download alone answer with `Cross-Origin-Resource-Policy: cross-origin`. Downloads are
  attachments typed as plain text, a raster, audio or video type, or bytes, never HTML or SVG, and
  SVG never serves as SVG. The service worker never answers for `/share`.
- With link previews on (per share, on by default), the page head gives chat apps the file's name,
  kind and size and a 1200 by 630 card rendered at share time; off, it gives the name alone and
  the card answers 404. A card a chat app already fetched stays in that app's cache after the
  share is revoked or expires.

## Plugins

Installing a Claude Code plugin runs its author's code on the host as the Seti user, in the
terminal and in every agent that loads it. Only the user installs, uninstalls, enables, disables or
updates plugins and adds or removes marketplaces, from Settings, Plugins: the EA's token and paired
devices are refused, and agents have no tool for it. Seti runs `claude plugin` with an argument
list and no shell, accepts only `name@marketplace` ids and marketplace sources made of URL and path
characters, refuses anything that starts with `-`, and passes the target after `--`. One change
runs at a time, each has a time limit, and the audit log records each with the CLI's answer. A
preview reads the marketplace manifest and, for a plugin inside the marketplace checkout,
`claude plugin details`, which lists its components without starting them.

## Mods

A mod acts on Seti as its own request source, `{ via: 'mod', modId, grants, scopes, eventId,
caller }` beside the user's, the EA's and agents', set by `asMod` in `server/src/access.ts` around
every call a mod makes through the mod API. Seti builds it from its own records; a mod's code never
supplies any of it. Its changes are audited with the actor `mod:<id>`. A user's request to a
mod's route under `/api/mods/<id>/` stays the user's, with every check that request already passed.

No mod, at any tier, runs programs, reads files beyond a `files.read` grant, sees secret or
connection values, changes security settings (access, the sandbox, credentials, connections, SSH,
permissions, Bypass or Seti control), creates share links, writes into an agent's conversation as
the user, or installs, enables or grants mods. `refuseMod` in `server/src/ea-guard.ts` refuses all
of it, and runs wherever Seti refuses the EA or agents' Seti tools for the same actions:
`refuseAgent`, `refusePromptAsUser`, `notEa` and `eaReadOnly` call it, so one set of guards covers
the EA, agents and mods.

What a mod may do is granted by capability, and `server/src/mods/capabilities.ts` is the one map
from each capability to the operations it allows; [Operations](#operations) lists them all. Every
mod reads its own settings, records the audit kinds it declared and sets the status items it
declared. Each capability is checked again inside its operation against the scope granted
(`server/src/mods/scopes.ts` and `server/src/mods/ops/`): `tasks.read` and `files.read` only for
the agents their filter covers, answering any other agent as if it did not exist; `tasks.manage`
only for the actions listed; `chat.post` only public or direct as granted, never to the user or
the EA, and a public post mentions no one, so it never wakes an agent outside the filter or the EA; `files.read` only within the globs, never a secret file; `net.fetch` and `connection` only
for their hosts, over HTTPS on port 443, never this machine, its networks or Seti's own names,
through the same guarded fetch pollers use; `storage` only under the mod's own id; `notify` only
its own kinds. A `connection` value is read in Seti's process at call time, set as the header the
user's connection names, and redacted from everything that goes back, so the mod never holds it.
Bundled mods also read their own `SETI_<ID>_*` environment variables; with `seti.version`, Seti's
changelog and update check; and with `workspaces.layout`, each workspace's panel layout through
core, which checks every layout and refuses a new terminal tile from the EA or an agent, as it does
on Seti's own route; and with `tasks.ask`, side questions to agents through core's side chat
engine, which forks the session itself, as whoever asked the mod: the caller of its route or its
command, so an agent's question gets no file reads and the audit names the asker. A bundled mod holds the capabilities its manifest declares,
since it is reviewed with Seti; a third-party mod holds only what the user granted.

Only the user turns on a third-party mod or one whose manifest says `securitySensitive`. The EA,
with `set_mod_enabled` after the user's yes, and agents at Seti control Full may turn ordinary
bundled mods on or off and change their settings; agents at Self may not, and safe mode, which keeps every third-party mod off, is the
user's alone. `SETI_SAFE_MODE=1` forces it on whatever the setting says. No one turns off a
required mod, one that is part of Seti; the server refuses it for every caller, though its settings
change under the rules above. Routes, public paths,
input hooks, fence renderers, styles, viewers of Seti's own file kinds, page viewers, host proxies,
PR decorators, status markers and agent accents are open to bundled mods only, and the public demo answers a mod's route only when
its manifest marks that route `demo`. A host proxy only names the HTTPS origin a subdomain of
`seti.localhost` is served from, such as a PR's preview: `server/src/subdomain-proxy.ts` proxies
the request after its own trust check, answers 404 on a subdomain no proxy serves, and leaves out
Seti's security headers only on responses it relayed. The PR previews mod that uses it is
security-sensitive, and the public demo answers every such subdomain with 404. A viewer never
changes a file's kind, what the raw route serves it as or its share page;
the share page renderers, which run converters, stay Seti's own. The Turn on button a file offers
for a mod that is off asks first when the mod is security-sensitive.

A mod command runs only for the callers its manifest names in `for`: the user from the palette or
a slash command, the EA through `run_mod_action`, and agents through `mod_<mod>_<command>`. A mod
never runs another command, and a device key reaches none. At Seti control Self an agent gets only
commands whose `level` is `self`, which act on the agent the `task` argument names, and Seti
resolves that argument to the caller alone. The EA asks the user before a command that `changes`
something, and Seti audits the run as `mod.action_run` with who asked and the names of the
arguments, never their values. The Turn on a command of a mod that is off offers asks first, or opens Settings, Mods,
when the mod is security-sensitive.

Third-party mod logic never runs in Seti's process. Each event gets a fresh QuickJS engine in a
long-lived runner child (`server/src/mods/logic/runner.ts`) that runs under Node's permission
model, reading only its own sources and the QuickJS packages, and inside bwrap with no network, no
capabilities and an empty environment where bwrap works. The engine has only the language's own
globals, and `eval` and the Function constructors are gone before the mod's code loads. Every call
out of the engine is one line on the child's stdio naming an op and its arguments: Seti checks the
line's size, that it belongs to the event it handed that child, the op, the capability and the
arguments' strict schema, then runs the op as the mod with the grants Seti read itself. The child
never names a mod, a grant or a caller, and never holds a connection value. Per-event limits on
memory, compute, wall time, calls and sizes are in `MOD_LIMITS`; a child that breaks the protocol
or runs past its wall time or memory is killed by its process id and replaced.

A theme mod has no code and holds no capability; it adds token values only, and a swatch colour in
its manifest is hex, so no value can carry other CSS. The EA and agents at Full may turn a theme mod
on or off like an ordinary bundled mod, and pick the theme, flavour and accent with
`set_mod_enabled` without asking, since appearance is not security. They pick only a theme whose
mod is on, with options it offers; the user may keep a theme whose mod is off. A change is audited
as `system.theme_changed`.

A style is CSS that ships inside Seti's own build: the UI adds only stylesheets listed in
`MOD_STYLES` in `ui/src/mods/bundled.ts`, so no mod brings CSS at run time, and a font it declares
loads from Seti's own origin under `font-src 'self'`.

Third-party mods are installed, granted, updated and removed by the user alone.
`requireUserConsent` in `server/src/mods/consent-guard.ts` refuses the EA, agents, mods and paired
devices on every route under `/api/mod-admin` and on turning a third-party mod on; it accepts a
browser session or a loopback request. While Require passkey is on, installing, granting, approving
an update or rollback that reaches further, Developer mode, turning a third-party mod on and
uninstalling also need a passkey check from the last five minutes in that session
(`POST /api/auth/step-up`, which sets `auth_session.stepped_up_at`). Install is offered only with
Developer mode on, which is off by default.

A package is a folder on the Seti host or an https git repository at a ref. Seti reads only the
files the manifest names (`seti-mod.json`, the `main` logic bundle, view pages, its icon, and
README, LICENSE and CHANGELOG), never runs a script from it and never reads `node_modules`. An SVG
icon is rebuilt from its shapes alone, with no scripts, styles, links or embedded images, and shown
only through an `<img>` data URL; a PNG icon is checked for its signature and size. A README or
changelog renders with raw HTML as text and images as links, so it loads nothing from elsewhere. It refuses
symlinks and hard links, git trees with a symlink or submodule, paths with `..`, a logic bundle
that imports anything, view pages with `<script src>`, inline event handlers, `javascript:` URLs,
`<meta http-equiv>`, `<base>` or `<link>`, and packages over 2 MB. Git is fetched into a bare
repository with no checkout, hooks, submodules, LFS, redirects, prompts or system config, at most
20 MB in a minute. A third-party
mod can never take the id of a mod Seti ships. Each version is pinned to a SHA-256 over its files and
kept in PostgreSQL; before a third-party mod starts, Seti hashes its stored files again and keeps it
off, logged and audited as `mod.files_changed`, when they no longer match.

The consent screen is written by Seti from the manifest, never by the mod: each capability in plain
words, what the mod adds, and warnings. Every granted host is two-way, which the copy says, and any
mod with a view is told to the user that its scripts can reach the internet through WebRTC. An
update that adds or widens anything waits for the user's consent and shows only the difference,
and a command that is new or changed in any way (its title, description, callers, level, args or
whether it changes something) counts as wider;
any other update applies after a delay the user sets (24 hours by default), with a notification
either way, and can be rolled back. A connection capability is bound to one of the user's
connections at install; the mod never sees its value. Mod bisect turns half of the enabled mods off
at a time to find the one behind a problem, and restores every mod when it ends.

A mod's webhook source never verifies a delivery itself, at any tier. Its manifest names the header that holds
the HMAC-SHA256 of the body, and Seti checks that signature with the channel's secret before any of
the mod's code reads the payload, so the mod never sees the secret and cannot accept an unsigned
delivery. While a source's mod is off, its webhooks answer 503 to every delivery and record why;
nothing falls back to accepting it unverified. A third-party mod's logic reads a
verified delivery with its headers filtered to `content-type`, `user-agent` and `x-` headers,
leaving out the signature header and any whose name mentions a signature, token, secret, auth, a
cookie, a key, a password, an HMAC, a credential or a session, and the event it returns passes the same credential redaction as every channel
event.

A mod's ask is the only way its logic starts or stops an agent. `tasks.start` and `tasks.stop`
record an ask (`server/src/mods/asks.ts`) with a summary Seti writes from the call, never from the
mod's own text, and notify the user; it expires after 10 minutes, and a mod keeps at most 3 open.
Only the user's own session or local token answers it through `POST /api/mod-asks/<id>`: the EA,
agents, mods and paired devices get 403, and each ask takes one answer. Allow runs exactly the
recorded call as the mod, only while the mod runs now (installed, on, its files matching and not
held by safe mode). An ask to start an agent in a repo names the repo, which must be one Seti has,
and an
agent it starts is sandboxed at Seti control Self on the default credential, with its first message
marked as the mod's.

Text a third-party mod adds reaches agents and the EA only labelled as the mod's. Its posts carry
`author_kind: 'mod'` and read as the mod's in every agent's update; its context text is fixed in
the manifest, quoted in full at consent, and wrapped in `<mod_context>` with a line saying the mod
wrote it; a command's result reaches the EA and agents wrapped in `<mod_output>`, and the EA's
prompt says mod output never answers a question. Task events carry only the event type, the agent's
id and the time, for agents the `tasks.read` filter covers. A status item is text of at most 40
characters that Seti draws itself. A third-party theme's token file passes a strict grammar at
install: custom properties under the theme's own selectors with colour values only, which Seti
rebuilds before it adds them to the page, so no theme brings a URL or a rule of its own.

Third-party install is offered only while Developer mode is on, and stays that way until the
third-party runtime has had an independent security review. `SETI_MOD_TEST_UPSTREAM` is a seam for
Seti's own tests that sends mods' requests for `.test` names to a fake upstream on this machine;
Seti honours it only with `SETI_TEST_MODS=1` in a development or test run.

### Operations

These are every operation a mod can call, from `MOD_OPS` in `shared/src/mod-runtime.ts`; nothing
else is reachable, and `server/src/mods/ops/ops.test.ts` fails when this table and `MOD_OPS` differ. Each runs only after the dispatcher checked its size, its event, the grant and
its strict argument schema.

| Op                       | Capability     | Scope check                                                                                                                                      |
| ------------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `settings.get`           | none           | The mod's own settings, with defaults                                                                                                            |
| `audit.record`           | none           | Kinds the manifest declares; detail at most 2 KB                                                                                                 |
| `status.set`             | none           | Items the manifest declares; 40 characters, once a second                                                                                        |
| `storage.get`            | `storage`      | The mod's own id from the call, never from its arguments                                                                                         |
| `storage.keys`           | `storage`      | Its own keys, at most 500                                                                                                                        |
| `storage.set`            | `storage`      | 64 KB a value, 1 MB a mod, keys of 1 to 200 characters                                                                                           |
| `storage.delete`         | `storage`      | Its own keys                                                                                                                                     |
| `notify.send`            | `notify`       | Its declared kinds and the user's switch per kind; 3 an event, 10 an hour; links stay on Seti routes                                             |
| `net.fetch`              | `net.fetch`    | HTTPS on port 443 to granted hosts; no IP literals or Seti names; public addresses only; redirects checked again; no hop-by-hop or proxy headers |
| `connection.fetch`       | `connection`   | The bound connection, read at call time; a host in both the grant and the connection; the value set by Seti and redacted from the answer         |
| `tasks.list`             | `tasks.read`   | Agents the filter covers                                                                                                                         |
| `tasks.get`              | `tasks.read`   | Agents the filter covers; others answer as missing                                                                                               |
| `tasks.transcript`       | `tasks.read`   | Direct messages hidden but the mod's own; credentials redacted; 50 entries, 256 KB                                                               |
| `tasks.prs`              | `tasks.read`   | Agents the filter covers                                                                                                                         |
| `tasks.manage.rename`    | `tasks.manage` | The action is granted; the agent is within the `tasks.read` filter                                                                               |
| `tasks.manage.pin`       | `tasks.manage` | The action is granted; the agent is within the `tasks.read` filter                                                                               |
| `tasks.manage.set_color` | `tasks.manage` | The action is granted; the agent is within the `tasks.read` filter                                                                               |
| `tasks.manage.link_pr`   | `tasks.manage` | The action is granted; the agent is within the `tasks.read` filter                                                                               |
| `tasks.manage.unlink_pr` | `tasks.manage` | The action is granted; the agent is within the `tasks.read` filter                                                                               |
| `tasks.manage.start`     | `tasks.manage` | The action is granted; records an ask the user answers                                                                                           |
| `tasks.manage.stop`      | `tasks.manage` | The action is granted; records an ask the user answers                                                                                           |
| `chat.post`              | `chat.post`    | `public` granted; 4000 characters; 3 an event, 30 an hour                                                                                        |
| `chat.post.direct`       | `chat.post`    | `direct` granted; an agent within the filter, never the user or the EA                                                                           |
| `files.list`             | `files.read`   | An agent within the filter, an open folder, folders the globs could reach                                                                        |
| `files.read`             | `files.read`   | The globs on both the path and its real path; no secret files; text only, 512 KB; credentials redacted                                           |

### Third-party mod views

A third-party mod's view or file viewer is one HTML page from its package, served by
`/api/mod-frames/<id>/<views|viewers>/<name>?v=<hash>` with the policy in
`server/src/mods/frames/policy.ts`:

```text
default-src 'none'; script-src 'sha256-<shim>' 'sha256-<each inline script>'; style-src 'unsafe-inline';
img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none';
child-src 'none'; worker-src 'none'; manifest-src 'none'; object-src 'none'; form-action 'none';
base-uri 'none'; frame-ancestors 'self'; sandbox allow-scripts; webrtc 'block'
```

Scripts run only when their text matches a hash taken when the package was installed, so markup a
view later builds from data, such as a transcript line in `innerHTML`, runs nothing. The route
answers only the user's own page: the EA, agents, mods and paired devices get 403, a request that
is not a frame's gets 403, and a mod that is off or held by safe mode, or a `v` that is not the
running package's hash, gets 404. Any framed request to another `/api/*` path gets 403 from
`framedApiGuard` in `server/src/app.ts`, so a view that navigates itself to the API loads no JSON;
Seti's page `frame-src 'self'` keeps it from navigating to the web.

A hash-pinned policy still lets a script element or a preload whose `integrity` matches a pinned
hash load from any URL, which would send a request to the web. So the policy also sets
`require-trusted-types-for 'script'` and `trusted-types default`, and the shim installs the only
policy first: it refuses every script and script URL from a string, and HTML that holds a
`<script>`, `<link>`, `<meta>`, `<base>`, frame or object element. The shim also makes
`createElement` and `createElementNS` refuse those elements, and install refuses `<link>` in a
page, so a page has none to clone.

Seti injects one script first (`server/src/mods/frames/shim.ts`). It locks those sinks, gives the
page in-memory storage, removes the WebRTC constructors, and asks Seti's page for its bridge with the frame's
nonce from the address fragment. Seti's page (`ui/src/mods/bridge.ts`) hands over a
`MessageChannel` port only when the hello comes from that frame's own window, from an opaque
origin, with its nonce, before any second load; every sandboxed frame's origin is `null`, so the
source decides. After that it ignores the window. Each port message is held to 64 KB and a rate
of 10 a second with a burst of 30, then parsed with the strict schemas in
`shared/src/mod-bridge.ts`; three violations close the port and the view shows that it was
stopped. A view reaches its own commands offered to views, its own storage and its own settings,
which the page relays to `/api/mod-frames/<id>/call` and the server runs as the mod; it never names
a core route, another mod or a capability op. A second load of the frame means it navigated, so
the page closes the port and says the view tried to leave. Links open only from Seti's own
dialog, and a view may open only the agents, an agent, the EA or its own sections.

A third-party file viewer never takes an extension Seti counts as a key, credential or env file
(`.pem`, `.key`, `.env` and the like, from `secretNameProblem` in `shared/src/secret-names.ts`), and
Seti's page never hands a viewer a file whose path looks like one, whatever its extension. The
consent screen says a viewer reads every file opened with it.

Browsers cannot close every way out: a view's scripts may still reach the network through a
WebRTC path the shim misses, such as the fresh globals of an `about:blank` frame, through DNS
prefetch, or through a browser feature that sends a request this policy does not name. Whatever a
mod hands its view may therefore leave the machine.

### Threats and controls

The attacker is a mod's author, whoever took over a benign mod's git source, or someone who writes
text a benign mod reads, such as a webhook payload.

| Goal                           | What stops it                                                                                                                                                                      |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reach Seti's API from logic    | No network globals in the engine; the only way out is an op; fetches go to granted hosts over HTTPS, every resolved address is checked, and Seti's own names are refused           |
| Reach Seti's API from a view   | `connect-src 'none'`, an opaque origin, `framedApiGuard` on framed `/api/*` requests, and a second load closing the bridge                                                         |
| Call core through the bridge   | A port handed only to the frame's own window after its nonce, strict schemas, and only the mod's own commands, storage and settings                                                |
| Act as another mod or the user | The mod id comes from `asMod`, never from arguments; posts carry the mod as author; `refusePromptAsUser` refuses mods                                                              |
| Read secrets                   | Connection values added in Seti's process and redacted; secret files refused; credentials redacted from files and transcripts; no environment in the runner                        |
| Run programs                   | No such globals in QuickJS; the runner has no child process, worker or addon grant and runs in bwrap; starting an agent needs the user's Allow                                     |
| Hide behaviour or persist      | The content hash checked before every start; git pinned to a commit; no `eval`; an update that asks for more waits for consent                                                     |
| Exhaust the host               | Compute slices, memory caps, wall timers that kill by process id, per-event call counts, queues, a daily compute budget, and caps on storage, posts and notifications              |
| Confuse the user at consent    | Reserved ids and names; consent copy written by Seti; the mod's description quoted; hosts in ASCII; frames inside Seti's chrome; Allow only in Seti's toasts                       |
| Get enabled without the user   | Install, grants, update consent, Developer mode and turning a mod on refuse the EA, agents, mods and devices; `defaultEnabled` refused; a passkey check when Require passkey is on |
| Shadow core or another mod     | Registries refuse a taken key, and everything a mod adds is named `<mod>.<name>`                                                                                                   |
| Attack through the package     | A bare git fetch with no checkout, hooks, submodules or LFS; symlinks refused; size caps; nothing in the package is run at install                                                 |

### Residual risks

1. A view can leak what its mod hands it. A scripted opaque-origin frame may still reach the
   network through a WebRTC path the shim misses, through DNS prefetch hints, or through a request
   path the policy, Trusted Types and the shim's guards do not cover, and `webrtc 'block'` is not in
   every browser yet. The consent screen says so for every mod with a view.
2. A granted host is two-way. A mod with `net.fetch` or `connection` to a shared API host can write
   what it reads into an account its author controls, which Seti cannot tell from honest use. The
   consent copy says it can send what it reads there.
3. Prompt injection through legitimate channels. Posts, context text, channel events and command
   results are text agents and the EA read; labels and wrappers lower the odds but do not remove
   them, and an agent persuaded by such text acts within its own access.
4. An engine or sandbox escape. A QuickJS bug together with a V8 WebAssembly bug would run code in
   the runner child. With bwrap that child has no network and no writable files, and only its
   strictly parsed stdio pipe to Seti; without bwrap, Node's permission model is the only wall, and
   Doctor and the consent screen say so. A child serves one mod only, so an escaped child never
   sees another mod's events or calls under its grants, but it can still call ops under its own
   mod's grants and read what bwrap leaves readable: the host's system files under a read-only
   `/`, with `/home`, `/run` and `/tmp` replaced by empty folders.
5. Consent fatigue. People approve what they do not read, so the screens stay short and an update
   shows only what changed.

## Terminals

Seti runs up to 16 interactive login shells, opened alone or as tiles of the grid mod. While the
grid mod is off its tiles leave the terminal lists, and their shells end 15 minutes after their last
window closed; the saved layouts keep them for when the grid is back. A shell opened for an agent starts in
its working directory. A sandboxed agent's shell is `bash -l -i` in its sandbox with the same
mounts, hidden paths, egress proxy and placeholder credentials; the sandbox's home is its own, so
the user's rc files do not load there. An unsandboxed agent's shell is the Seti user's own login
shell from its passwd entry, run with `-l -i` as a terminal window runs it, so it loads the user's
profile and rc files. It starts with the user's names, home, locale, PATH and session sockets, and
none of the server's other variables: Seti's settings, the Anthropic API key and the variables
pnpm sets stay out. Both run in a memory scope held to the agent's cap. The one difference from a
`!` command is that the sandbox keeps the terminal as its controlling terminal, which job control
and Ctrl+C need: that pseudo-terminal belongs to the sandbox alone, and nothing outside it reads
its input. A shell opened outside an agent starts in the Seti user's home folder, as an unsandboxed
agent's shell does, in a memory scope held to the default cap.

Each terminal is a WebSocket at `/api/terminals/<id>`, where the browser picks the id as it opens a
tab. Its upgrade passes the same Access or local-token checks as every API call, and it must also
come from Seti's own origin. The EA's token and paired devices are refused, as are archived agents
and an id already running for another agent. Input arrives as JSON messages of at most 8192
characters in frames of at most 64 KB, and a connection that sends faster than its budget is
closed. Seti keeps the last 128 KB of output so a reload, or the panel opened again, within 15
minutes reattaches; after that, or when the user closes its tab, the agent is archived or deleted,
its sandbox or directory changes, or Seti stops, the shell and everything it started get SIGHUP,
then SIGKILL. The audit log records each terminal's start and end, never what was typed.

A program in a terminal, such as tmux or Claude Code, can write to the browser's clipboard with
an OSC 52 sequence, of at most 1 MiB, so its copy reaches the system clipboard. It can never read
the clipboard: Seti ignores OSC 52 read requests and sends no answer, so nothing running in a shell
learns what the user copied elsewhere.

## Where each secret lives

| Secret                             | Stored as                                | Read by                     |
| ---------------------------------- | ---------------------------------------- | --------------------------- |
| Secret                             | Stored as                                | Read by                     |
| ---------------------------------- | ---------------------------------------- | --------------------------- |
| Secret store key                   | key file `secret-key`                    | `seti.service`              |
| Local token of the user            | key file `local-token-user`              | `seti.service`, the browser |
| Local token of the EA              | key file `local-token-ea`                | `seti.service`, `seti-ea`   |
| OpenAI key                         | key file `openai-api-key`                | `seti.service`, `seti-ea`   |
| Deepgram, ElevenLabs and TURN keys | key files `deepgram-api-key` and so on   | `seti-ea.service`           |
| Tunnel token                       | key file `tunnel-token`                  | `cloudflared.service`       |
| GitHub tokens for agents           | sealed rows per credential and owner     | the egress proxy            |
| Claude long-lived token            | sealed row                               | the egress proxy            |
| SSH private keys for agents        | sealed rows                              | each task's ssh-agent       |
| Webhook signing secrets            | sealed column                            | the webhook receiver        |
| Connection values                  | sealed rows per connection and slot      | pollers, the egress proxy   |
| Push notification key pair         | sealed row, made on first start          | the push sender             |

Key files sit in `~/.seti/credentials` (0600 files in a 0700 directory). Each unit loads only its
own with systemd's `LoadCredential=`, so none reaches an environment variable or a command line, and
agent sandboxes see neither that directory nor `/run/user`. Sealed values use AES-256-GCM bound to
their name, never leave the server, and are set, cleared and audited in Settings, Credentials and
Settings, Connections without their value; a connection's key can also be set on the Allow of the
agent request that asked for it. Without systemd (`scripts/start.sh`), the server reads
the same directory itself, or `SETI_CREDENTIALS_DIR`, and hides it from sandboxes the same way.
Development and test runs use `SETI_HOME/dev-credentials` instead and create what is missing;
production never creates a key file and stops naming the missing one. `scripts/install.sh` creates
them, owner-only, and never prints one.

A connection's value reaches only the hosts the user gave it. Agents hold a placeholder, and the
proxy swaps it for the value in headers and URLs on those hosts over HTTPS; a request carrying it
anywhere else is refused and audited. Request bodies pass unread. A connection added for an agent's
request joins only the asking agent's credential, with the key the user pasted on Allow or with
none until the user fills it in. The EA and agents' Seti tools cannot see or change connections; the server
refuses them.

## Public demo

The public demo is a separate entry point, `server/src/demo/main.ts`, that starts only with
`SETI_DEMO=1`. It seals its process so nothing can start a program, open a terminal or reach the
network beyond loopback, answers only the routes on its allowlist, and runs in a locked-down
container that resets every few hours. The normal server never loads it. Its threat model and
what it refuses are in [Public demo](demo.md).

## What is not protected

systemd 255's user manager cannot decrypt credentials, so the key files are plain files the
Seti user can read, and the database is not encrypted by Seti. An unsandboxed agent runs as that
user and can read them. Full-disk encryption of the host volume is the control for data at rest;
the sandbox is the control for agents.

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

## Audit

The audit log records user, agent and system actions, including outward agent tool calls
such as pushes, and the calls Claude Code's auto mode classifier turned down. Each event stores the SHA-256 of its fields and of the event before it; the audit
page verifies the chain, and Seti writes the chain head to the journal every day, which the Seti
user cannot rewrite. Comparing the two shows whether events were removed or rewritten wholesale.
A side chat is recorded as `task.side_chat` when it starts, without its questions or answers,
which stay in the server's memory and are redacted before they reach the browser. It is recorded
as whoever asked the side chat mod, never as the mod.
