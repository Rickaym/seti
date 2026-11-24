# Mods

TLDR: Seti takes three tiers of mods. A theme mod adds colours and nothing else. A bundled mod is
Seti's own reviewed code in `mods/<id>/`, shipped in the build. A third-party mod is a folder or a
git repository the user installs; its logic runs in a locked-down QuickJS sandbox outside Seti's
process, its views run in sandboxed frames, and it reaches Seti only through the capabilities the
user granted. This guide covers third-party mods first, then bundled and theme mods. What a mod may
and may not do is in [section 17 of the protocol](protocol.md#17-mods); this guide is how to build
one for Seti.

## Building a third-party mod

A third-party mod is a package of plain files: a `seti-mod.json` manifest, an optional `logic.js`
that Seti runs one event at a time in a sandbox, optional HTML pages that Seti shows in sandboxed
frames, and optional theme token files. It never runs inside Seti's process or its UI, and every
call it makes into Seti is checked against what the user granted at install. Install stays behind
Developer mode in Settings, Mods until third-party mods have had an independent security review.

The worked example is `e2e/fixtures/mods/kitchen-sink/`, which uses every capability and every
point a third-party mod may use. `e2e/fixtures/mods/hostile-view/` and
`e2e/fixtures/mods/hostile-logic/` try every way out of the sandbox, and Seti's tests check that
each one fails.

### Start from the template

```sh
pnpm mod new linear-issues   # copies packages/mod-api/template into ./linear-issues
cd linear-issues && pnpm install
pnpm mod build               # bundles src/logic.ts into logic.js
pnpm mod test                # builds, then runs the mod's tests with Vitest
pnpm mod check               # validates the package as Seti will and prints its consent copy
pnpm mod dev .               # loads the folder into the Seti on this machine as a dev mod
```

The template holds `seti-mod.json`, `src/logic.ts`, `test/logic.test.ts`, `package.json` (with
`@seti/mod-api`, `esbuild`, `typescript` and `vitest` as dev dependencies), `tsconfig.json` and a
`README.md`. `pnpm mod build` bundles everything into one ES module and fails on any `node:` import,
since nothing exists inside Seti to import. `pnpm mod check` prints the content hash, the size and
the exact lines the user reads on the consent screen. Seti never runs a package's install scripts
and never reads its `node_modules`.

### The package

Seti reads only the files the manifest names, from a folder on the Seti host or from an https git
repository at a commit, tag or branch:

| File                                   | Rule                                                                  |
| -------------------------------------- | --------------------------------------------------------------------- |
| `seti-mod.json`                        | Required, at most 64 KB, a valid manifest for the third-party tier    |
| `main`, such as `logic.js`             | One UTF-8 ES module, at most 512 KB, ending in `.js`, with no imports |
| `views[].entry`, `fileViewers[].entry` | Self-contained `.html` pages, at most 512 KB each and 8 in all        |
| `themes[].tokens`                      | A `.css` file of theme tokens, at most 64 KB, under the token rules   |
| `README.md`, `LICENSE`, `CHANGELOG.md` | Optional, at most 64 KB each, shown as plain text                     |

A package is at most 2 MB in all. Paths are plain ASCII, relative, with `/` between folders and no
`.` or `..` parts, and never inside `node_modules`. A folder may not reach a listed file through a
symlink or a hard link, and a git tree may not hold a symlink or a submodule. The logic bundle may
not use `import` in any form, nor `export ... from`. A page may not load a script from a file
(`<script src>`), use an inline event handler such as `onclick`, a `javascript:` URL,
`<meta http-equiv>`, `<base>` or `<link>`; every script is inline, and a view cannot add a script,
link or frame element at run time.

Each version is pinned to a SHA-256 over its files, shown as `sha256:` and 12 hex digits. Seti keeps
the files in its database and hashes them again before the mod starts, so a version whose files
changed stays off.

### The manifest

```json
{
  "id": "linear-issues",
  "name": "Linear issues",
  "version": "0.1.0",
  "seti": "^1.8",
  "author": "Your name",
  "description": "Links agents to Linear issues.",
  "main": "logic.js",
  "capabilities": [{ "name": "net.fetch", "hosts": ["api.linear.app"] }, { "name": "storage" }],
  "activation": ["onCommand"],
  "contributes": {
    "commands": [{ "id": "link-issue", "title": "Link issue", "for": ["palette", "view"] }]
  }
}
```

Everything a mod adds is named `<mod>.<name>`, so it never shadows Seti or another mod. A
third-party mod may use these contribution points:

| Point              | What it adds                                                                     |
| ------------------ | -------------------------------------------------------------------------------- |
| `settings`         | A settings page Seti draws from the schema; logic reads the values               |
| `commands`         | Actions with typed arguments for the palette, the EA, agents and the mod's views |
| `slashCommands`    | Composer commands that run one of its commands                                   |
| `channelSources`   | Webhook sources whose deliveries its logic reads; poller templates are not open  |
| `views`            | A sandboxed page in a `section`, an `agentTab` or the `sidePanel`                |
| `fileViewers`      | A sandboxed page for file extensions Seti does not know                          |
| `statusBar`        | Status bar items whose text its logic sets                                       |
| `notifications`    | Notification kinds, each with the user's own switch                              |
| `contextProviders` | Fixed text added to agents' instructions, with the `agents.context` capability   |
| `themes`           | Token sets, under the token rules below                                          |
| `auditKinds`       | Audit records of its own, as `mod.<id>.<kind>`                                   |
| `schedules`        | Runs every 5 minutes to 1 day                                                    |
| `taskEvents`       | Agent events it hears, with the `tasks.read` capability                          |

Routes, public paths, input hooks, shortcuts, status markers, agent accents, styles, host proxies,
PR decorators, fence renderers, transcript blocks and PR chips stay with the mods Seti ships. A third-party command binds no key
chord, and a third-party file viewer cannot take Seti's own file kinds, serve pages or sit behind a
settings switch. Seti also refuses a third-party manifest that:

- sets `defaultEnabled` (an installed mod stays off until the user's consent), sets `required`
  (which only mods Seti ships may set) or names `onStartup`;
- takes a reserved id (`seti`, `core`, `system`, `mod`, `mods`, the group chat's reserved handles
  such as `ea` and `user`, or the id of a mod Seti ships), or the name Seti, EA or Executive
  Assistant;
- asks for `seti.version`, `tasks.ask` or `workspaces.layout`, which are for bundled mods;
- names an `activation` event with nothing to fire it, or declares something without its event:
  `onCommand` goes with `commands`, `onWebhook` with webhook `channelSources`, `onSchedule` with
  `schedules` and `onTaskEvent` with `taskEvents`, and each needs `main`.

Hosts in `net.fetch` and `connection` are names, never IP addresses, local names or Seti's own
hostnames. A wildcard is allowed only as `*.<registrable domain>`, so `*.example.com` passes while
`*.github.io` and `*.co.uk` are refused.

### Capabilities

The user grants every capability at install, and Seti writes the consent copy, never the mod.

| Capability       | Scope                                                                                | What the user reads, for example                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `tasks.read`     | `agents`: handles or `role:<name>`; none means every agent                           | Reads @builder: status, PRs and transcripts. Direct messages stay hidden.                                            |
| `tasks.manage`   | `actions` from `rename`, `pin`, `set_color`, `link_pr`, `unlink_pr`, `start`, `stop` | Renames and pins agents and links their PRs. Asks you before it starts an agent.                                     |
| `chat.post`      | `public`, `direct` or both                                                           | Posts in the group chat as Linear, and messages one agent directly.                                                  |
| `files.read`     | `agents` and relative `paths` globs                                                  | Reads files matching notes/\*\*/\*.md in the folders of @builder. Never keys, credentials or .env files.             |
| `net.fetch`      | `hosts`, on HTTPS port 443                                                           | Sends and receives data with api.linear.app. It can send what it reads there.                                        |
| `connection`     | `variable` and `hosts`, bound to one of the user's connections                       | Uses your LINEAR_API_KEY connection with api.linear.app. It never sees the key, and it can send what it reads there. |
| `storage`        | its own data                                                                         | Keeps up to 1 MB of its own data in Seti.                                                                            |
| `notify`         | its declared notification kinds                                                      | Sends you notifications: Issue updated.                                                                              |
| `agents.context` | `agents`                                                                             | Adds text of its own to the instructions of @builder, with the exact text quoted.                                    |

`files.read` globs use only `*`, `**` and `?`, and never cover `.env`, `.git` or key files; `**`
alone is refused, so name the files, such as `notes/**/*.md`. A `connection` capability works only
with a connection whose header Seti sets, such as `Authorization: Bearer`. The consent screen also
warns, for any mod with a view, that its scripts can reach the internet through WebRTC, and for a
wildcard host, that it reaches every subdomain.

### Logic

`logic.js` exports one object of handlers by default. `defineLogic` from `@seti/mod-api/logic`
types it and disappears in the bundle.

```ts
import { defineLogic } from '@seti/mod-api/logic'

export default defineLogic({
  commands: {
    'link-issue': async (args, ctx, seti) => {
      const response = await seti.fetch('https://api.linear.app/graphql', {
        connection: 'LINEAR_API_KEY',
        method: 'POST',
        body: JSON.stringify({ query: '{ viewer { id } }' }),
      })
      await seti.storage.set('last', await response.json())
      return { text: 'Linked' }
    },
  },
  webhooks: { linear: async (delivery) => ({ title: 'Issue changed', kind: 'issue.updated' }) },
  schedules: { digest: async (tick, ctx, seti) => seti.chat.post('Daily digest') },
  taskEvents: async (event, ctx, seti) => seti.storage.set('last-event', event),
})
```

Each handler gets its input, a frozen `ctx` of `{ eventId, mod: { id, version }, caller, agentId? }`
and the `seti` object. `caller` is `user`, `ea`, `agent`, `view`, `webhook`, `schedule`, `task` or
`user-allowed`; it is for the mod's own information, and grants never depend on it.

| Event        | Fired by                                                                | Input                                       | Output                                    |
| ------------ | ----------------------------------------------------------------------- | ------------------------------------------- | ----------------------------------------- |
| `commands`   | The palette, a slash command, the EA, an agent's tool, the mod's views  | The arguments, checked against the manifest | The result; `{ text }` is what people see |
| `webhooks`   | A delivery to a channel of the source, after Seti checked its signature | `{ sourceId, headers, body, receivedAt }`   | One event, or `null` to ignore it         |
| `schedules`  | Every `every` (`5m` to `1d`), started up to 10% late                    | `{ scheduleId, since, now }`                | Ignored                                   |
| `taskEvents` | An agent the `tasks.read` filter covers                                 | `{ type, taskId, at }`                      | Ignored                                   |

A webhook's `body` is the delivery's JSON as text, and its `headers` hold only `content-type`,
`user-agent` and `x-` headers, never the signature header or one whose name mentions a signature,
token, secret, auth, a cookie or a key. The event it returns is
`{ title, body?, url?, kind?, severity? }`, with a title of at most 200 characters, a body of at
most 2000 and a severity of `info`, `success`, `warning` or `critical`; Seti names the mod as its
source, redacts credentials and routes it like any channel event. When the mod's queue is full the
sender gets 503 and tries again. A schedule starts only after its last run ended, and `since` is
when that run started (null the first time). Task events are `turn_finished`, `needs_you`,
`status_changed`, `pr_linked` and `pr_merged`, and carry only ids; the handler reads more through
`seti.tasks`.

Every call on `seti` is one request to Seti, which checks it as the mod, within the grants:

| Call                                                                                           | Needs                                               |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `settings.get()`                                                                               | nothing; the user's values with defaults            |
| `storage.get(key)`, `keys(prefix?)`, `set(key, value)`, `delete(key)`                          | `storage`                                           |
| `log(...values)`                                                                               | nothing; the mod's own log in Settings              |
| `audit(kind, summary, detail?)`                                                                | a kind in `auditKinds`                              |
| `notify(kind, { title, body, url? })`                                                          | `notify`, a kind in `notifications`                 |
| `fetch(url, init?)`                                                                            | `net.fetch`, or `connection` with `init.connection` |
| `tasks.list({ status?, limit? })`, `get(id)`, `transcript(id, { limit?, before? })`, `prs(id)` | `tasks.read`                                        |
| `tasks.rename`, `pin`, `setColor`, `linkPr`, `unlinkPr`                                        | `tasks.manage` with that action                     |
| `tasks.start({ title, prompt })`, `tasks.stop(id)`                                             | `tasks.manage` with that action; asks the user      |
| `chat.post(text)`, `chat.post(text, { to })`                                                   | `chat.post` with `public`, or `direct`              |
| `files.list(agentId, dir)`, `files.read(agentId, path)`                                        | `files.read`                                        |
| `statusBar.set(item, { text })`                                                                | an item in `statusBar`                              |

`fetch` answers `{ status, ok, url, headers, text(), json() }`, where `text()` and `json()` return
promises and `headers.get(name)` reads a header. With `connection`, Seti adds the key on its own
server, replaces any header of that name the mod set, and redacts the key from everything that comes
back. `files.read` answers `{ path, size, text }` for text files with credentials redacted, and an
agent outside the filter answers as if it did not exist. Posts carry the mod as their author and
are labelled as the mod's wherever agents read them. A public post mentions no one, so `@` handles
in it are refused; reach one agent with a direct message instead.

A refused or failed call throws an `Error` whose `code` says why:

| Code      | Meaning                                            |
| --------- | -------------------------------------------------- |
| `denied`  | Not granted, outside the scope, or not declared    |
| `invalid` | The arguments do not fit                           |
| `limit`   | A cap was reached, such as size or rate            |
| `asked`   | The call waits for the user                        |
| `failed`  | The call reached Seti or the host and failed there |
| `busy`    | The mod's queue is full; try again                 |

Each event gets a fresh engine, so module variables never survive; keep state in `storage`.
Settings are read-only from logic. Storage writes land per call, not per event, so a handler that
fails halfway keeps the writes it made. Code cannot be compiled from text: `eval` and the Function
constructors are gone. The engine limits are `mod_limits` in
[Appendix A](protocol.md#appendix-a-reference-constants); the rest of `MOD_LIMITS` in
`shared/src/mod-runtime.ts`:

| Limit                    | Value                                              |
| ------------------------ | -------------------------------------------------- |
| Compute without awaiting | 500 ms                                             |
| A call's arguments       | 64 KB                                              |
| A fetch                  | 15 s, 1 MB a response, 4 MB an event, 64 KB a body |
| A handler's result       | 64 KB                                              |
| Log                      | 50 lines of 500 characters an event                |
| Compute per day          | 600 s, then the mod pauses until midnight          |
| Failures                 | 5 in a row back off                                |

Storage, posts and notifications are capped per operation, below.

### Operations

Every call on `seti`, and every call a view relays, is one of these operations, from `MOD_OPS` in
`shared/src/mod-runtime.ts`; nothing else is reachable, and `server/src/mods/ops/ops.test.ts` fails
when this table and `MOD_OPS` differ. Seti checks the call's size, its event, the grant and the
strict argument schema before it runs one.

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
| `tasks.transcript`       | `tasks.read`   | Direct messages hidden but the mod's own; credentials redacted; runtime rows as events; 50 entries, 256 KB                                       |
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

### Asking the user

`seti.tasks.start` and `seti.tasks.stop` never act by themselves (MOD-8). They record an ask and
resolve to `{ asked: <id> }`. Seti shows a toast that stays, "<Mod> asks you", with what the Allow
does in Seti's own words, the full prompt, and Allow and Deny buttons. An ask expires after 10
minutes, and a mod keeps at most 3 open.

### Commands and where their results go

A command runs where its `for` says: `palette` (and any slash command that names it), `ea`,
`agents` (the seti tool `mod_<mod>_<command>`) and `view`. Seti checks the arguments against the
manifest first and resolves a `task` argument to the agent's id. A result that is a string or has a
`text` field shows as a toast in the palette; a failure shows as "<Mod>: <command> failed:
<reason>" in a toast that stays. The EA and agents read a result wrapped as
`<mod_output mod="<id>">`, labelled as data from the mod and not from the user, so text inside it
never passes for Seti or the user.

### Views and file viewers

A view or viewer is one HTML page from the package. Seti serves it in a frame with no network, an
opaque origin and a policy that runs only the inline scripts whose hashes it took at install, so
markup a page builds later from data runs nothing. The page draws inside Seti's chrome, which names
the mod; a page with `phone: false` is not shown on a phone, and Seti says it opens on a larger
screen instead. Views fill their slot; file viewers may ask for a height between 48 and 1600 px.

Seti injects `window.seti` before the page's own scripts. `@seti/mod-api/view` types it:

| Call                                                  | Does                                                                          |
| ----------------------------------------------------- | ----------------------------------------------------------------------------- |
| `ready()`                                             | Hides Seti's loading state; a viewer gets its file after it                   |
| `run(command, args?)`                                 | Runs one of the mod's commands whose `for` includes `view`                    |
| `storage.get`, `keys`, `set`, `delete`                | The mod's own storage, with the `storage` capability                          |
| `settings.get()`                                      | The mod's settings                                                            |
| `on('context' \| 'theme' \| 'file' \| 'storage', fn)` | Where it is shown, Seti's theme, the opened file, a storage key logic changed |
| `resize(height)`                                      | A viewer's height, at most 4 times a second                                   |
| `open(route)`                                         | Opens the agents, an agent, the EA or one of the mod's own sections           |
| `link(url)`                                           | Asks the user, in Seti's own dialog, before opening a web page in a new tab   |

A view reaches nothing else: no core route, no other mod and no capability op. Messages are held
to 64 KB, 10 a second with a burst of 30 and 8 calls in flight; three violations stop the view, and
so does a page that navigates away. Seti sends its theme as custom properties, so a page that uses
`var(--background)`, `var(--foreground)`, `var(--muted-foreground)`, `var(--border)`,
`var(--primary)` and `var(--radius)` matches Seti in light and dark. Fonts and images load only as
`data:` or `blob:` URLs, and `localStorage` lives in memory for as long as the page is open.

### Status items, context and themes

A `statusBar` entry is `{ id, title, icon?, command? }`. Its logic sets the text with
`seti.statusBar.set(id, { text })`, at most 40 characters and once a second; Seti draws the text
itself, never markup, and pressing the item runs the named command.

A `contextProviders` entry has fixed `text` of at most 2000 characters, shown verbatim at consent.
The only substitutions are `{{settings.<key>}}`, filled from the user's own settings. Seti adds it
to the instructions of the agents the `agents.context` filter covers, wrapped in
`<mod_context mod="<id>">` with a line saying the mod wrote it, not the user. Any change to the text
counts as asking for more at update.

A theme's `tokens` file holds only rules of custom properties under
`:root[data-theme='<mod>.<theme>']`, optionally with `.dark` or `:not(.dark)` and up to two
`[data-flavour='...']` or `[data-accent='...']` options. Every value is a colour (hex, `var(--x)`,
`transparent`, `rgb()`, `hsl()`, `oklch()`, `oklab()` or a `color-mix()` of those), or a plain
`rem` or `px` length for a token whose name holds `radius`. Seti rebuilds the CSS from the
declarations it checked, so a theme can recolour Seti but never load a URL or style an element.

### Install, updates and dev mode

1. Turn on Developer mode in Settings, Mods.
2. Press Add, which opens `#settings/mods/add`, give a folder path or a git URL and ref, and press
   Check. Seti shows the mod as its page will: its icon, its README and the consent copy for each
   permission.
3. Pick a connection for each `connection` capability and press Install, which lands on the mod's
   page at `#settings/mods/<id>`. With Require passkey on, Seti asks for a fresh passkey check
   first.

An installed mod starts on. Only the user installs, grants, updates, rolls back and uninstalls
(MOD-15), though agents may write a mod in their workspace for the user to install. A git install follows its branch or tag and is checked once a day; a folder
install updates when the user presses Check. An update that asks for more, including a new host,
wildcard, agent, glob, action, notification kind, view, schedule, task event, channel source,
context text or any new or changed command, waits for the user's consent and shows only the difference. Any other update applies
after a delay the user sets, 24 hours by default, with a notification. Seti keeps two earlier
versions to roll back to, and uninstalling asks whether to delete the mod's data. Storage survives
updates and rollbacks, so read old data shapes as well as new ones.

`pnpm mod dev <folder>` hands a folder to the Seti on this machine with its local token, while
Developer mode is on. A dev mod says so in its Manage dialog and is not pinned: Seti reloads it
whenever its files change. Its first load and any change that asks for more wait for consent;
turning Developer mode off unloads every dev mod.

Safe mode, a switch in Settings, Mods or `SETI_SAFE_MODE=1`, keeps every third-party mod off. Find
culprit runs a mod bisect: it turns half of the enabled mods off at a time, asks whether the
problem is still there, and restores the rest when it ends. Neither ever turns a required mod off,
and a bisect leaves them out of its suspects.

### Testing

`pnpm mod test` builds the mod and runs its Vitest tests. `createFakeSeti({ manifest, grants?,
settings?, storage?, fetch? })` from `@seti/mod-api/testing` gives a handler a fake `seti` with
in-memory settings and storage, a route table for `fetch`, and Seti's refusals for what the grants
do not cover:

```ts
import { createFakeSeti } from '@seti/mod-api/testing'
import manifest from '../seti-mod.json' with { type: 'json' }
import logic from '../src/logic.js'

it('says hello and counts', async () => {
  const { seti, ctx } = createFakeSeti({ manifest, settings: { greeting: 'Hi' } })
  expect(await logic.commands.hello({}, ctx, seti)).toEqual({ text: 'Hi (1)' })
})
```

The fake runs handlers in Node, not in Seti's engine, and refuses `tasks`, `chat` and `files`
calls, so test those against a dev mod. Seti's own tests install the kitchen sink and run every one
of its events in `server/src/mods/kitchen-sink.test.ts` and `e2e/tests/mods-kitchen-sink.spec.ts`,
and run the hostile fixtures in `e2e/tests/mods-hostile.spec.ts`.

## Building a bundled mod

A bundled mod is a folder in `mods/<id>/` with a manifest, a server half and optionally a UI half,
typed against `@seti/mod-api`; a theme mod is a manifest and a CSS file of token values. Register it
in `server/src/mods/bundled.ts`, and turn it on in Settings, Mods. `mods/weather/` and
`mods/whats-new/` are working examples.

### The folder

```
mods/weather/
  package.json     @seti/mod-weather, depending on @seti/mod-api
  tsconfig.json    copied from mods/whats-new/tsconfig.json
  seti-mod.json    the manifest
  server.ts        exports the server half
  ui.tsx           exports the UI half
  *.test.ts        its tests, run by `vitest run` from the package's test script
  vitest.config.ts copied from mods/weather/vitest.config.ts, in a mod with tests
```

The folder name, the manifest's `id` and the package name `@seti/mod-<id>` agree; a test fails
when they do not. A mod imports only `@seti/mod-api`, `react`, `lucide-react` and its own files in
the same folder, and its tests may import `vitest` too. A mod with tests has a `vitest.config.ts`
that re-exports `modTestConfig` from `@seti/mod-api/vitest`, which gives each mod its own Vitest
cache folder so the parallel `pnpm test` runs never clear one another's cache; a test fails when
it is missing. A mod may also import the npm packages its own `package.json` lists in
`dependencies`, with their subpaths and Vite's `?url`; one that does adds `vite/client` to its
tsconfig `types`. Files that the server half imports name
their imports with `.js`, as the server's own code does.

### The manifest

`seti-mod.json` says who the mod is, which mod API it needs (`"seti": "^1.0"`), the capabilities
it asks for and what it contributes. Seti validates it with `modManifest` in `shared/src/mods.ts`
and shows any problem in Settings, Mods. Everything a mod adds is named `<mod>.<name>`, so it never
shadows Seti or another mod. Set `defaultEnabled` for a feature that moved out of core, so it stays
on until the user turns it off, and `securitySensitive` for a mod only the user may turn on.

Set `required` for a mod that is part of Seti, such as What's new, GitHub webhooks, poller
templates and Previews. A required mod is always on, for every caller, and starts even when it was
stored off; safe mode and a mod bisect leave it on, and its settings still change as an ordinary
bundled mod's do. Settings, Mods shows it with a Core badge and a lock in place of its switch. Only
a bundled mod may be required.

This Seti offers mod API 1.23.0, which adds the bundled-only `tasks.dream` capability
(`api.dreams`: a night of dreams, whether dreams have news, waiting clean-ups, and a dream started
under Seti's caps); 1.22.0
hands `tasks.transcript` the agent's runtime rows as
neutral events (`{ kind: 'events', payload }`, typed as `SetiTranscriptEntry`) in place of the
runtime's own messages, which were never typed; 1.21.0 added transcript blocks, `api.transcript.refresh` and
stored asides (`aside.list`, `remove` and `clear` in place of `close`, and `done` events that
carry the stored aside instead of `turns_left`); 1.20.0 added `api.app.stepOwnMessages`; 1.19.0 added
`takesTerminalKey` to input hooks; 1.18.0 added fence
snapshots for share pages; 1.17.0 added
`required`; 1.16.0 added agent accents; 1.15.0 added agent docks, streaming
routes, menu commands and `tasks.ask`; 1.14.0 added `api.app.every`, `api.keys.label` and `aria`, `api.terminals.useOwn`
and `api.agents.open()` without an id; 1.13.0 opened commands, slash commands, webhook sources,
status items, context text, themes, schedules and task events to third-party mods; 1.12.0 added
viewer and fence renderer switches; 1.11.0 added status markers; 1.10.0 added the listing fields
below; 1.9.0 added agents layouts, terminal sources, header commands, chords and the
`workspaces.layout` capability; 1.8.0 added `@seti/mod-api/logic`, `/view` and `/testing` for
third-party mods; 1.7.0 added sandboxed views and file viewers for third-party mods,
in a section, an agent tab or the side panel; 1.6.0 added PR decorators, host proxies and PR chips; 1.5.0 added
styles; 1.4.0 added `api.app`, hook overlays and the kit's dialog and status item. Capability scopes are narrow by schema: `tasks.manage` lists
actions from `rename`, `pin`, `set_color`, `link_pr`, `unlink_pr`, `start` and `stop`; agent
filters name group chat handles or `role:<name>`; `chat.post` says `public`, `direct` or both;
`files.read` globs are relative, use only `*`, `**` and `?`, and never cover `.env`, `.git` or
key files; and no host may be a wildcard over a public suffix such as `*.co.uk` or `*.github.io`.

### How a mod presents itself

Settings, Mods lists each mod with its icon, name, one-line description, publisher and version,
and gives it a page with tabs for its README, permissions, settings, contributions and changelog.
These manifest fields fill them in, and every one is optional:

- `displayName`: the name the list and the page show, up to 60 characters; `name` stays the short
  name that consent copy and posts use.
- `description`: one line, with no line breaks.
- `icon`: a lucide icon name such as `cloud-sun`, or, in a third-party package, an `.svg` or `.png`
  file. Seti keeps only an SVG's shapes, paint and groups, and drops scripts, styles, links and
  embedded images; a PNG is at most 512 by 512 pixels. An icon file is at most 32 KB.
- `author`: the publisher; Seti marks a third-party author unverified.
- `categories`: up to three of `themes`, `viewers`, `channels`, `integrations`, `agents`,
  `keyboard`, `appearance` and `other`.
- `homepage` and `repository`: https URLs, opened in a new tab.
- `readme` and `changelog`: Markdown files in the package, `README.md` and `CHANGELOG.md` when the
  manifest names none. Seti renders them with raw HTML shown as text and images shown as links, at
  most 64 KB each.

A third-party package's icon and documents count toward its size limit, and Check refuses a file
the manifest names when it is missing, too large or not a valid icon. A bundled mod keeps
`README.md` and `CHANGELOG.md` beside its manifest, with a lucide icon and its categories; a test
fails when one is missing.

### Where each point lives

Each contribution point is a `Registry` (`shared/src/registry.ts`): entries by key, a key taken
once, and every registration returns a disposer the mod host (`server/src/mods/host.ts`,
`ui/src/mods/host.ts`) keeps per mod. Core registers its own entries through the same registries.
`server/src/mods/bundled.ts` lists the bundled mods (`BUNDLED_MODS`, `THEME_MODS`, and `TEST_MODS`
for `SETI_TEST_MODS=1`), and `bundled.test.ts` fails on a folder that is missing from it. Each
point's registry sits beside the code it extends, such as `slashCommands` in
`server/src/mods/points.ts` or `statusBarItems` in `ui/src/components/status-bar/items.ts`.
Every point takes effect at once except context, which reaches new sessions. Public paths are
declared but not available yet. A third-party mod's events go to its `logic.js` through the logic
pool in `server/src/mods/logic/`, and its views are served by `server/src/routes/mod-frames.ts`
under the policy in `server/src/mods/frames/policy.ts`.

### The server half

```ts
import { defineMod } from '@seti/mod-api'
import manifest from './seti-mod.json' with { type: 'json' }

export const weatherServer = defineMod({
  manifest,
  server: (api) => {
    api.route('GET', '/now', async () => ({ body: await api.storage.get('last') }))
  },
})
```

Every call on `api` runs as the mod and within its capabilities: `settings.get`, `storage` and
`cache` (a value that expires, shared by Seti's processes) with the `storage` capability, `notify`,
`audit` for kinds the manifest lists, `fetch` for the hosts its `net.fetch` names, `version` for
Seti's changelog and update check with `seti.version`, `aside` for side questions to agents with
`tasks.ask`, and `route` for routes the manifest declares. A route marked `"stream": true` answers
with `streamRoute` instead, writing server-sent events with `stream.send(event, data)` until the
handler ends; `stream.signal` aborts when the caller leaves, and a throw before the first event is an
ordinary refusal. `seti.version` and `tasks.ask` are for bundled mods only. `aside` acts as whoever
asked the mod, the caller of its route or command. Seti stores each answered question as an aside
of the agent, which `aside.list` reads and `aside.remove` and `aside.clear` delete, and stops every
answer being written when the mod is turned off. `transcript.refresh(task)` tells the mod's UI half
that its transcript blocks for the agent changed (see Transcript blocks below). `env('URL')` reads the mod's own `SETI_<ID>_URL` and nothing else of the environment.
Registrations are undone when the mod is turned off; `api.onDispose` takes anything else to undo,
such as a timer. A route marked `"demo": true` answers in the public demo, so a mod lists there
exactly the routes the demo may use.

### Commands

A command is an action with typed arguments, declared once in the manifest and offered where its
`for` says: `palette` (and any slash command whose `command` names it), `agentHeader` (an icon in
the desktop agent header, run on that agent), `agentMenu` (a row in an agent's More actions menu on
a phone and in a layout's panel, run on that agent), `ea` (the EA's `run_mod_action`, listed in its
prompt while the mod is on) and `agents` (the seti tool `mod_<mod>_<command>`). The server half
answers it:

```ts
api.registerCommand('wave', ({ args, caller }) => Promise.resolve(`Waved at ${String(args.task)}`))
```

Seti checks the arguments against the manifest before the handler runs, and resolves an argument
named `task` to the id of the agent it names. `level: "self"` marks a command that acts only on the
agent `task` names, so agents at Seti control Self get it for themselves; other commands reach
agents at Full only. `changes: false` lets the EA run it without asking first, and `timeoutSeconds`
says how long Seti waits for the handler. A palette or menu command takes no required argument
besides `task`, which Seti fills with the agent, and a slash command's text goes to the one string
argument besides `task`. A header command takes `task`. In the UI half,
`registerCommand({ id, icon, run, when, title, waits, status })` gives a command its icon, can run
it in the UI instead of on the server, offers it only where `when` answers true, and names it by
state with `title`, such as Unlock while locked; both get the agent, the section and whether the
layout is narrow. `status` is what the reply box says its slash command will do, and `waits` holds
the slash command in the box with a reason while it cannot run, such as while an answer streams.
The palette and menus show a command's chord, else the slash command that runs it. While a bundled
mod is off its slash commands and palette commands say it is off, with a Turn on button, and never
reach Claude Code.

A bundled mod's command may carry a `chord` such as `"Alt+G"`: Alt or Ctrl (Cmd on Apple), maybe
Shift, then a letter, digit, arrow or bracket. Seti binds it while the mod runs and shows it in the
palette and the shortcut guide. A chord Seti or another running mod already binds stops the mod
with "Alt+G is taken by <owner>". Keys a view binds only while it shows go through
`api.keys.useChords`, with a `shortcuts` entry (`keys`, `title`, `group: anywhere | agents`) that
puts their row in the guide.

### Input hooks

A bundled mod adds keyboard behaviour with an `inputHooks` entry and
`api.registerInputHook({ id, onKeyDown, takesEscape, takesTerminalKey, onFindEnter, overlay })`;
`overlay` is drawn above the page while the hook is registered, such as a dialog that lists its
keys. A terminal keeps every key for its shell unless `takesTerminalKey` says the key is the
hook's; the terminal then leaves it alone and it reaches `onKeyDown`, which is how Vim mode's
Ctrl+\ n leaves a terminal. `api.panels` finds Seti's panels, their scroll areas, reply boxes,
terminals and find bars, and marks the active one; `api.app` opens the palette and the group chat,
keeps focus where a key put it, and says through `narrow` when the layout shows one pane, as on a
phone. Hooks see every key, so third-party mods never get them. `mods/vim/` is the example: it
binds single keys only while it is on and the screen is wide, so a mod that binds single keys
ships with `defaultEnabled: false`.

### PR decorators, host proxies and PR chips

A bundled mod can fill in a PR's `preview` and `preview_host` as Seti fetches the PR, serve
subdomains of Seti's host, and put a chip beside each PR in an agent's PR row. Declare
`prDecorators`, `hostProxies` and `prChips` entries, then register them:

```ts
api.prs.decorate('preview', (pr, comments) => ({ preview: detectPreview(comments, pr.headOid) }))
api.registerHostProxy('preview', async (hostname) => previewTarget(await api.prs.open(), hostname))
```

A decorator reads the PR and its newest 30 comments, and Seti keeps only an HTTPS preview and a
host that is a subdomain of `seti.localhost`. A host proxy answers only with the HTTPS origin a
subdomain is served from; Seti itself proxies each request, so the mod never sees one. The first
two points are open to bundled mods only, and `mods/pr-previews/` uses all three.

### Status markers and agent accents

A bundled mod can draw the status marker beside each agent (in the list, Needs you, the grid, its
picker, the legend, the phone header and Home), and an accent at the left edge of each agent row
in place of the colour bar. Declare a `statusMarkers` or `agentAccents` entry, then register the
component:

```tsx
api.registerStatusMarker({ id: 'blobs', view: Blob })
api.registerAgentAccent({ id: 'blobs', view: BlobBookmark })
```

A view gets the agent's `status`, the `agent` (`id` and `color`, or null in the legend) and its
`place`. Seti keeps the slot, the accessible name and the tooltip, so the view is decoration: it
gets `currentColor` as the status colour and `--agent-stripe` as the agent's colour fitted to the
theme, while `agent.color` is the `#rrggbb` the user chose. The first one registered draws them
all, and a view that throws or renders nothing, or turning its mod off, brings Seti's own back. An
accent fills a slot 6 px inside the row's left edge, up to the row's inner height (36 px with a
mouse, 43 px on touch); while it shows, Seti hides the row's marker from sight but not from screen
readers, and a view that renders only an element with `data-accent-blank` keeps its width with
Seti's bar and marker back. The colour helpers `oklch`, `rgbOfOklch`, `rgbOf`, `hexOf` and
`contrast` come from `@seti/mod-api`. `mods/blobs/` is the example of both.

### Channel sources

A mod adds a sender a webhook can take, or a script a new poller can start from, with a
`channelSources` entry in its manifest and a registration in its server half. A webhook source
declares how its sender signs (`signature.header` and `prefix`), the header with the sender's
delivery id, whether Seti issues the secret or the sender does, and the event kinds it reports.
Seti verifies the HMAC-SHA256 signature itself before the mod's `parse` runs, and signs the
mod's `sample` for the Test button, so the mod never sees a secret.

```ts
api.registerWebhookSource('github', {
  parse: (payload, headers) => ({ kind: 'ignore', reason: 'ping' }),
  sample: () => ({ headers: { 'x-github-event': 'ping' }, body: '{}' }),
})
api.registerPollerTemplate('feed', { script: FEED_SCRIPT })
```

Each source is named `<mod>.<id>`, such as `github-webhooks.github`; `generic` and `blank` are
Seti's own, as are the catalog senders such as `linear` and the user's `custom` ones, which are
data and need no mod ([Webhook senders](setup.md#webhook-senders)). Write a mod only for a
sender that needs code, such as one that tracks states or signs something the definition cannot
describe. While the mod is off its sources leave the New menus, and its webhooks refuse every
delivery with "The <mod> mod is off" until it is on again. `mods/github-webhooks/`,
`mods/sentry-webhooks/` and `mods/poller-templates/` are the examples.

### The UI half

A mod with a UI half adds `ui.tsx` to its folder, exports it as `./ui` from its package, and lists
it in `ui/src/mods/bundled.ts`; a test fails when the folder and the list disagree. A mod with no
server half, such as `mods/previews/`, exports `./seti-mod.json` and lists `{ manifest }` in
`BUNDLED_MODS`, so the server still knows it.

```tsx
export const weatherUi = defineMod({
  manifest,
  ui: (api) => {
    api.registerStatusBarItem({ id: 'now', view: WeatherNow })
  },
})
```

`registerSection`, `registerView`, `registerDock`, `registerStatusBarItem` and `registerFileViewer`
take the id of an entry the manifest declares, and `registerFenceRenderer` a fence language it declares. `registerView` places a view the manifest puts in `header`, the
band across the app header, or in `about`, a part of Settings, About; `registerNews` puts a dot on
the way to an `about` view while its signal is on. `registerDock` draws a view the manifest places
in `agentDock` over an agent's chat: a panel on a wide screen and in a layout's panel, a bottom
sheet on a phone. Seti draws its frame, with the view's icon, title, `description` and a close
button, and Esc closes it; `api.agents.openDock(agent, id)` opens it, again to focus it, and
`onClose` runs when it closes or the agent's view goes away. `api.agents.send` messages an agent as
the user, and `api.stream` reads one of the mod's `stream` routes. `mods/side-chat/` is the example. `registerSettingsPage` replaces the page Seti
draws from the mod's settings. `api.request` calls the mod's own routes, `api.poll` polls one
while a view reads it, `api.useSettings` and `api.saveSettings` read and save its settings on the
server, `api.kit` holds Seti's buttons, fields, toggles, dialog, status item, markdown, transcript lines and failure toast,
and `api.onDispose` takes anything else to undo. `registerAgentsLayout` adds a way to show several
agents at once for a view in `agentsLayout`: the Agents section shows it instead of one agent while
it is on, at most one layout is on, and a view with `phone: false` never shows on a narrow screen.
`registerTerminalSource` lists the mod's terminals beside the device's own. `api.agents` and
`api.terminals` give a layout Seti's agent view, frame, Files dock, list pieces and terminal
views; `api.panels.markers` mark its panels for the focus API. A layout's
`hidesList` hides the agents list while it shows. The server half's
`api.workspaces.grids` keeps a layout per workspace with the bundled-only `workspaces.layout`
capability, and a route's `request.caller` says whether the user, the EA or an agent sent it.
`mods/grid/` is the example: a core mod, on by default, that shows agents and terminals side by
side. With it off, every device shows one agent at a time, its chords and toggles are gone, and the
saved layouts stay in Seti's table for when it is back. Views use Seti's theme tokens, never raw colours, and a
view the manifest marks `phone` must work on a phone, with a phone spec beside its desktop spec.

### Transcript blocks

A bundled mod can draw blocks inline in an agent's transcript, among the agent's own rows, such as
the side chat's asides. Declare a `transcriptBlocks` entry (`id`, `title`), then register a source
with the same id:

```tsx
api.registerTranscriptBlocks({
  id: 'asides',
  watch: (agent) => store.watch(agent),
  blocks: (agent) => store.view(agent).blocks,
  subscribe: (agent, listener) => store.subscribe(agent, listener),
  refresh: (agent) => store.reload(agent),
  view: AsideBlock,
})
```

Seti calls `watch` while the agent's transcript shows and the stop it returns once it goes, so the
mod fetches its blocks only then. `blocks` lists the agent's blocks as `{ id, at }`, oldest first
and the same array until they change, and `subscribe` says when they change for that agent alone.
Seti places each block before the first row stored after its `at` and draws it with `view`
(`{ agent, id }`) behind its own error boundary. After the server half changes an agent's blocks,
`api.transcript.refresh(task)` sends a content-free `blocks` event on the transcript's stream and
the UI calls the mod's `refresh`. `mods/side-chat/` is the example.

### File viewers

A `fileViewers` entry says which files a viewer shows: `extensions` Seti does not know, or, for a
bundled mod, `kinds` of Seti's own (`mermaid`, `csv`, `spreadsheet` and `pdf`), whose files keep
their kind, icon and share page. `text` says the viewer shows the file's text, which Seti reads for
it up to 2 MB; `maxBytes` is the largest file it takes; `source` adds a Source toggle that shows the
text instead; `whileEditing` shows the saved file under the editor; and `page`, bundled only, has
Seti serve its extensions to a frame as sandboxed pages through `?preview=1`. Another mod or Seti
cannot hold an extension or a kind a running mod holds, so a second claim keeps that mod off.

```tsx
api.registerFileViewer({ id: 'pages', load: async () => import('./PdfView').then((m) => m.pdfView(api.kit)) })
api.registerFenceRenderer({ language: 'mermaid', load: async () => import('./Fence').then((m) => m.fence(api.kit)) })
```

A fence renderer may also give `snapshot`, which draws a fence as a standalone SVG for a share
page in the `light` or `dark` scheme, or answers null. A share page runs no script, so when the
user shares a Markdown file the share dialog calls it for each fence of that language and the
server rasterizes the drawings into the page; a file whose kind is the fence's language, such as
a `.mmd` file, is drawn whole. The drawing should use colours for a plain page and SVG text in a
common sans font, since the server draws text with DejaVu and Liberation fonts. Without
`snapshot`, or with the renderer switched off, a shared fence shows as code.

A viewer gets the file's name, kind, size, change time, `url`, `download`, `page`, `text`, the
`line` a search opened it at, whether the user is `editing` it, and the `theme`, whose `key`
changes with the theme; `load` makes the viewer its own chunk, fetched the first time a file opens.
`kit.ViewerActions` puts buttons in the file's header and `kit.fetchRaw` loads `url`; a lazy viewer
that draws with the kit takes it from a function its chunk exports, as `mods/previews/` does. Seti picks a
file's viewer in this order: an enabled mod's viewer of its extension, then of its kind, each only
within its `maxBytes` and on a phone only when it says `phone`. With none, a text
file opens as text and any other file offers its download; when a bundled mod that is off would
show it, a line names the mod with a Turn on button. `fenceRenderers` does the same for Markdown
fences of a language, which otherwise show as highlighted code. `mods/sample/` registers a viewer
for `.samplenote` files and a renderer for `sample` fences.

A viewer or fence renderer may name a `setting`, a boolean setting of the same mod, as its switch:
Seti registers it only while that setting is on, and adds or removes it as the setting changes,
with no restart. A file whose viewer is switched off falls back as above, and its line names the
switch and opens the mod's settings at it. Only a bundled mod's viewers take a switch, and a page
viewer never does.

`mods/previews/` is the bundled viewer of Seti's own kinds (PDFs, CSV files and workbooks, and
Mermaid diagrams, each behind its own switch and loaded as its own chunk), and reads workbooks in
a Web Worker that `ON_DEMAND_ASSET` in `ui/vite.config.ts` keeps out of the precache.
`mods/html-preview/` is the `page` viewer of `.html` and `.htm`: the frame and its Scripts toggle
are the mod's, while the route that serves the page and its security policy stay Seti's.

### Theme mods

A theme mod adds colours and nothing else: a folder with `package.json`, `seti-mod.json` and a CSS
file of token values, with no code. `mods/claude-theme/` is the one to copy, and
`mods/catppuccin/` adds flavours and accents. The manifest's `themes` entry names the theme's
`id`, `title`, `tokens` file and a light and dark `swatch` of `background`, `primary` and
`foreground` in hex.

The theme's id is `<mod>.<theme>`, such as `dusk.dusk`, and every rule in `tokens.css` starts with
`:root[data-theme='dusk.dusk']`, adding `.dark` for dark values. It defines every token
`ui/src/components/theme/themes/default.css` defines. A theme may offer `flavours` (dark palettes,
set as `data-flavour`) and `accents` (set as `data-accent`), each a list of options with a
fallback; `mods/catppuccin/` shows both. `schemes` pins a theme to light or dark alone.

The package exports `./seti-mod.json` and `./tokens.css`. List the manifest in `THEME_MODS` in
`server/src/mods/bundled.ts` and the tokens in `THEME_TOKENS` in `ui/src/mods/bundled.ts`; tests
fail when either list and the folder disagree. `themes.test.ts` checks every theme in `mods/`:
each token in each scheme, AA contrast for text and marks in every flavour and accent, agent
colours on its surfaces, and a swatch that matches the colours it shows.

### Styles

A bundled mod may add stylesheets with `styles` entries, each naming a CSS file beside its manifest:
`{ "id": "emoji", "file": "emoji.css" }`. The UI adds each one to the page as the mod starts and
removes it as the mod stops, so turning the mod on or off needs no reload. Seti bundles the CSS as
its own chunk, listed by `<mod>.<style>` in `MOD_STYLES` in `ui/src/mods/bundled.ts`, and fetches it
only while the mod is on; a test fails when that list and the manifests in `mods/` disagree. A
third-party or theme mod cannot add styles.

Seti's font stacks name a `Seti Emoji` family after the text font and before the platform's own, so
a style that declares an `@font-face` of that family, with a `unicode-range` of emoji, draws emoji
everywhere text is drawn, fields and the terminal included. `mods/twemoji/` does this with a
COLRv0 colour font, which Chromium and Safari both draw.

### Testing

`mods/sample/` uses every contribution point Seti takes from mods except channel sources, which
the three channel source mods show, and styles, which `mods/twemoji/` shows. `server/src/mods/host.test.ts`
shows how to turn a mod on and off in a test and check that it leaves nothing behind, and
`e2e/tests/mods.spec.ts` does the same in the browser. `mods/weather/forecast.test.ts` runs a
server half on a fake `ServerModApi`, and `e2e/tests/weather.spec.ts` turns a bundled mod off and
on again in the browser. The sample loads only with
`SETI_TEST_MODS=1`, which the e2e suite sets.

With the same switch Seti also loads `view-test` (`server/src/mods/frames/view-test.ts`), a
third-party mod with sandboxed views in a section, an agent tab and the side panel, and a file
viewer, whose pages Seti serves from memory. `e2e/tests/mods-views.spec.ts` drives its bridge.
