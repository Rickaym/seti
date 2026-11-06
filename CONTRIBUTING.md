# Contributing to Seti

TLDR: work on a branch, open a PR with a conventional commit title, and run `pnpm check` plus the
e2e specs you touch before every push. [CLAUDE.md](CLAUDE.md) lists the principles and hard rules
every change respects, for people and agents alike; this page is the reference behind them: setup,
workflow, tests, recipes, the security checklist, the UI rules and how changes reach users.

Seti is a self-hosted control room for Claude Code agents working on your repos. People read it on
a phone between other things, so every screen answers "what needs me?" first, and anyone who can
drive its API can run commands as its user, so least privilege comes before convenience. Most
review comments trace back to one of those two facts.

## Getting set up

[docs/setup.md](docs/setup.md) installs Seti and its dependencies, and its
[Development](docs/setup.md#development) section covers running it from a clone. For development
you need:

- Node 24 and pnpm through corepack (`corepack enable pnpm`).
- PostgreSQL 16, with a role for your user that can create databases
  (`sudo -u postgres createuser --createdb "$USER"`). Tests clone a template database per test file
  and drop it afterwards; set `SETI_TEST_DATABASE_URL` to use another server.
- Redis for the cache tests: `scripts/install.sh --with-redis` sets up Seti's own instance, or set
  `SETI_TEST_REDIS_URL` to one you run.
- uv, which `pnpm check` uses for the EA's checks.
- bubblewrap and socat for the agent sandbox, which the installer adds on Linux.
- Playwright's Chromium for the e2e suite: `pnpm --filter @seti/e2e exec playwright install chromium`.

Then:

```sh
pnpm install                       # also installs the git hooks
NODE_ENV=development pnpm start    # or pnpm dev:server and pnpm dev:ui for reloads
```

Development mode creates its own tokens in `~/.seti/dev-credentials`; sign in with
`local-token-user` from there. Give a second instance its own `SETI_HOME`, port and
`SETI_REDIS_URL=off` so it never shares a live one's data.

## Workflow

For anything larger than a fix, open an issue first and describe the problem it solves. A feature
that does not earn its place gets a plain no, and hearing it before the code exists saves everyone
time. The same goes the other way: when a review asks for something you think is wrong, say so.

1. Branch from `main`. Never commit to `main` directly.
2. Make the change with its tests and docs. Keep one concern per PR.
3. Run `pnpm check` and the e2e specs your change touches, then push.
4. Open a PR. Push new commits for review fixes instead of rewriting history; never force-push a
   branch someone else works on. The squash merge folds them into one commit anyway.
5. Resolve each review thread once a pushed commit fixes it. Leave a thread you dispute open and
   reply with your reasoning.

## Commits and PRs

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/); commitlint
checks each one in the `commit-msg` hook, and CI checks the PR title the same way. Use the types
the log already uses (`feat`, `fix`, `perf`, `refactor`, `test`, `docs`, `ci`, `chore`) and a scope
when one area owns the change, such as `terminal`, `files`, `shares`, `channels`, `ea`, `prs`,
`settings` or `phone`. Header and body lines stay within 100 characters, so wrap the body by
hand. Mark a breaking change with `!` after the type or a `BREAKING CHANGE:`
footer.

Merges are squash-only, so the PR title becomes the one commit on `main` and the line users read
in What's new. Write it as the outcome for the user, in everyday words: "feat(terminal): pinch and
Ctrl+= font size, remembered per device", not "feat: add font size handler".

A PR description starts with a short paragraph saying what changes and why. For a feature, a
"What changes for the user" section comes next; then sections as the change needs them, such as
"Security model", "Storage" and "Tests". Describe what the code does now, not how you got there,
and leave out notes addressed to reviewers or to yourself: the description is part of the record.

## Gates

`pnpm check` runs every gate CI runs on Node code, in this order: Prettier, the ASCII and YAML text
check, TypeScript, ESLint with zero warnings, knip, the unit tests, the EA's ruff, pyright and
pytest, and the UI build. The git hooks run a fast subset: Prettier, ESLint and the text check on
staged files before a commit, commitlint on the message, and `pnpm typecheck` and `pnpm knip` before
a push. Never skip them with `--no-verify`.

`pnpm lint` runs ESLint once per TypeScript project, each directory with a `tsconfig.json`, through
`scripts/lint.mjs`. Typed linting keeps every project it opens in memory until the process ends, so
one process per project keeps the peak at the largest project instead of the sum of all of them.

CI adds `pnpm audit`, a gitleaks scan of the PR's commits, the whole e2e suite in four shards, and
the Android build when `android/` changes. A PR merges only when all of it passes.

The lint rules that surprise people most:

- `seti/comment-style`: a comment is one line of ASCII under 100 characters; consecutive line
  comments and multi-line block comments fail. Docstrings (`/** ... */`) are fine.
- `seti/no-raw-colour`: UI code uses theme tokens, never palette classes, hex values or colour
  functions.
- `max-lines` 400 per file, `complexity` 15, `max-params` 4 and `max-depth` 4. Split the code; do
  not disable the rule.
- `import-x/no-default-export`, no enums (a union of string literals instead), no `for...in`, and
  `strict-boolean-expressions`.
- Every `eslint-disable` needs a description after `--`, and an unused one fails.

## Tests

Unit tests use Vitest next to the code (`server/src/*.test.ts`, `ui/src/**/*.test.ts`). Run one
file while you work:

```sh
pnpm --filter @seti/server exec vitest run src/shares.test.ts
pnpm --filter @seti/ui exec vitest run src/lib/failure.test.ts
cd ea && uv run pytest tests/test_tools.py
```

Route tests call `createApp().request(...)` with the user's test token from `server/src/test-auth.ts`
and assert on the response and on the audit events it recorded.

The e2e suite runs the built UI against a real Seti per worker, each with a scratch home, database
and tokens, and fakes for Claude Code, `gh` and the planner from `e2e/tests/support/`. It never
touches a running instance. Build first, then name the specs:

```sh
pnpm build
pnpm e2e share-links                       # desktop and both phones
pnpm e2e share-links --project=desktop     # one project
pnpm e2e share-links --project=pixel-7
```

Playwright has three projects. `desktop` runs every `*.spec.ts` at 1440 by 900. `iphone-15` and
`pixel-7` run every `*.phone.spec.ts` with the phone's viewport, touch and user agent. A UI change
gets a phone spec beside its desktop one, because every flow must work on a phone. Workers default
to half the cores, at most four; `SETI_E2E_WORKERS` sets them. Failed runs leave traces and the HTML
report in `e2e/playwright-report` (`pnpm --filter @seti/e2e exec playwright show-report`).

The README's screenshots come from `e2e/screenshots/`, a separate Playwright config that seeds
fictional demo data, stops the clock and writes WebP frames to `docs/screenshots/`. After a change
to a page the README shows, run `pnpm screenshots`; frames that only differ by antialiasing stay as
they are.

## Code map

- `server/src/`: the Node server (Hono). `app.ts` builds the app and mounts every router;
  `runner.ts` owns the open Claude Code sessions; `tasks.ts` starts tasks.
- `server/src/routes/<area>.ts`: one router per area.
- `server/src/store/`: SQL. `<area>.ts` holds typed queries, `schema-<area>.ts` the migration SQL,
  and `schema.ts` the ordered `MIGRATIONS` list.
- `server/src/seti-tools/`: the Seti tools an agent gets; `levels.ts` says which at each Seti control
  level.
- `server/src/share-preview/`: share page renderers; `converter.ts` runs external converters in a
  sandbox.
- `server/src/channels/`, `pollers/`, `reminders/`: webhooks, poller scripts and reminder scripts,
  all feeding one event path.
- `server/src/demo/`: the public demo, its route allowlist, process seal and fakes; the normal
  server never imports it. See [Public demo](docs/demo.md).
- `shared/src/`: zod schemas and types for requests, responses and rules both sides apply.
- `ui/src/`: the React UI. `panels/` holds the views, `panels/settings/` the settings pages (listed
  in `pages.ts`), `components/ui/` the shadcn components and `components/theme/themes/` the colour
  tokens.
- `mods/`: the mods bundled with Seti, one package each, and `packages/mod-api/`, the only part of
  Seti they import. See [Building a bundled mod](docs/mods.md).
- `ea/`: the Executive Assistant, a Python process (pipecat) that acts only through Seti's API.
- `e2e/`: the Playwright suite. `android/`: the Kotlin app with widgets. `deploy/`: systemd units,
  the health check and the demo's container. `scripts/`: installer, upgrade and repo checks.
- `docs/`: [setup](docs/setup.md), [architecture](docs/architecture.md),
  [security](docs/security.md), [pollers](docs/pollers.md), [mods](docs/mods.md) and the
  [public demo](docs/demo.md).

## Recipes

### Add a route

1. Define the request and response shapes as zod schemas in `shared/src/<area>.ts` and export them
   from `shared/src/index.ts`.
2. Put the SQL in typed functions in `server/src/store/<area>.ts`.
3. Write the handler in `server/src/routes/<area>.ts`. Check bodies with `validJson(schema)` and
   params with `valid('param', schema)`, matching ids with an anchored pattern. Answer with
   `ok(c, data)` and throw `HttpError` for a refusal.
4. Mount the router in `createApp` in `server/src/app.ts`. Paired devices reach nothing new; only
   `DEVICE_ROUTES` opens a route to them.
5. Record every change with `audit.record`, with a new kind in `AUDIT_KINDS` in
   `shared/src/audit.ts` and a summary a person can read. Keep secret values out of the detail.
6. If the route touches security settings or secrets, refuse the EA with `notEa` or `eaReadOnly`
   and agents' Seti tools with `refuseAgent` from `server/src/ea-guard.ts`. Otherwise give the EA a
   tool for it in the same PR (below).
7. Test it in `server/src/routes/<area>.test.ts`, and call it from the UI with `apiGet`, `apiPut`
   and the rest of `ui/src/api.ts`.

### Add a setting

1. Find the settings page that already covers the concern and add a card there; a new page is the
   last resort. A new page goes in `ui/src/panels/settings/pages.ts` with an icon and keywords for
   the command palette.
2. Store it in Postgres: a migration for its table or column, typed functions in the store, and
   its default in `shared/src/<area>.ts`. Use an environment variable only for what Seti needs
   before the database is up, and add it to the configuration tables in `docs/setup.md`.
3. Serve it with a GET and a PUT route, audited (see Add a route).
4. Build the card from `SettingsCard` and `SettingRow`. An on/off choice is a switch. A setting
   that narrows access starts at the safe value, and its off state looks normal, not red.
5. Give the EA the setting by extending the tool it already has for that area, as the CPU cap
   joined `get_memory_cap` and `set_memory_cap`, unless it is a security setting.
6. Cover it with a desktop and a phone e2e spec; the whole page must work on a phone.

### Add an EA tool

The EA sends its whole tool list on every call, and the model takes at most 128 tools, so first
look for a tool to extend with an argument. `ea/tests/test_tools.py` fails past the cap.

1. Declare a `ToolSpec(name, description, properties, required)` in the area's module in
   `ea/src/seti_ea/` and add it to `TOOL_SPECS`, `ACTION_SPECS` or `SETTINGS_SPECS`.
2. Implement it through `SetiClient` (`seti.py`), calling the same routes the UI calls, so the
   change is audited as the EA's.
3. A tool that changes something takes a `confirmed` argument, checks `await gate.cleared(...)` with
   a `gate_key` of the exact change, and returns `ask(...)` from `gate.py` until the user said yes.
   Seti stores the question, and a yes reaches it through `confirm_asked` or a notification.
4. Give agents with Full Seti control the same tool in `server/src/seti-tools/` with `setiTool(...)`,
   added to `catalog.ts`, or list it in `NOT_FOR_AGENTS` in `parity.test.ts` with the reason.
5. Test it in `ea/tests/`; `pnpm check:ea` runs ruff, pyright and pytest.

No tool, for the EA or for agents, answers permission requests, changes permission rules, or
shares or publishes anything; `parity.test.ts` fails on such names.

### Add a migration

1. Write the SQL as an exported constant in `server/src/store/schema-<area>.ts`, with a docstring
   saying what it adds.
2. Append `{ version: <next>, name: '<snake_case>', sql: <CONSTANT> }` to `MIGRATIONS` in
   `server/src/store/schema.ts`. Add `run` for data moves SQL alone cannot make; it runs in the
   same transaction.
3. Never edit, renumber or reorder a migration that has shipped. Seti applies pending migrations at
   startup, in order, in one transaction under an advisory lock.
4. Prefer additive changes (new tables, nullable or defaulted columns), so the previous release
   still runs on the new schema when an upgrade rolls back.
5. Test a migration that moves data with a `*-migration.test.ts` that seeds the old shape.

### Add a share preview type

1. Write a renderer in `server/src/share-preview/<type>.ts` that returns a `RenderedPreview`: the
   page body, a label such as "PDF, 12 pages", a note on what it leaves out, an error, and an
   optional card thumbnail.
2. Route the file to it from `byType` in `render.ts`, by kind or extension. A new extension's kind
   goes in `EXTENSION_KINDS` in `shared/src/files.ts`.
3. Escape all file content with `escapeHtml`. The page has no script and loads nothing from
   elsewhere; images go through `imageSlots()`, which stores them with the share and caps their
   count and size.
4. Run any program that parses the file through `server/src/converter.ts`, which sandboxes it with
   no network and caps its memory, CPU time, output and run time. Never spawn a converter directly.
   A failed run falls back to the source or the download with a message.
5. Test with fixtures in `share-preview/converters.test.ts` or `text-previews.test.ts`, extend the
   `share-previews` e2e specs, and add the type to the share links section of `docs/security.md`.

## Security review

Every new route, tool, page, process or path gets these questions before review. The answers go
in the PR's "Security model" section when the change adds surface.

- Who can reach it: the signed-in user, the EA, agents at Seti control Self or Full, paired devices, or
  anyone? Security settings and secrets stay the user's. A path that answers without a login needs
  an exact anchored pattern, a handler that reads only the database, a rate limit per client and
  the same 404 for every miss.
- Does it start off? New access, such as a host, a key, a capability or a public surface, is off
  until the user turns it on.
- Is every input checked with zod, with sizes capped and ids matched by anchored patterns?
- Does a path resolve its symlinks and stay inside its root, with hidden paths and Seti's own data
  refused? Folders are removed only through `owned-dirs.ts`.
- Does a process run with an argument list and no shell, refuse values that start with `-`, pass
  targets after `--` and stop at a time limit? Untrusted files are parsed only in the converter
  sandbox.
- Can a secret leak? Secrets are sealed in the secret store, never returned to the browser, never
  put on a command line or in an agent's environment, and never enter a sandbox; the egress proxy
  adds them. Logs, transcripts and audit details carry no values (`server/src/scrub.ts`).
- Is every change audited with its actor?
- Does a served page set the security headers, run no script and drop cookies?
- Does `docs/security.md` say what changed?

Report a vulnerability through GitHub's private vulnerability reporting on
[rickaym/seti](https://github.com/rickaym/seti), never in a public issue.

## UI rules

- Labels are one or two words with a lucide icon ("Import", not "Import sessions"); detail goes
  in a tooltip. People remember actions by their icons.
- A binary mode is a toggle or a switch, never a select.
- Every flow works on a phone, configuration included. Touch targets stay large enough for a
  finger, and nothing scrolls sideways.
- Needs you holds the agents that cannot go on without the user, each with a reason line, and the
  status bar shows one "N need you" item. Every new kind of stall goes through
  `server/src/task-blocked.ts`. A failing CI run shows on the agent's PR chips instead.
- An agent that fails while the user looks elsewhere raises a toast that stays until dismissed.
- A least-privilege state is muted, never red and never styled as an error. Colour marks what an
  agent can reach.
- No single-key shortcuts. Esc closes and stops, Ctrl+K (Cmd+K on a Mac) opens the palette, and
  other navigation uses modifier combos. The Vim mode mod (`mods/vim/`), off until the user turns it
  on, is the one exception, and it binds nothing destructive.
- Restart, Fresh and Archive sit in the footer of the agent's settings, each with a line saying
  what it does to the agent.
- Components come from `ui/src/components/ui` (shadcn) and colours from the theme tokens, so every
  theme and both modes work.

## Docs and writing

Docs record what the code does not make obvious: decisions, limits, security boundaries and setup.
Update them in the PR that changes the behaviour. Write prose first, in plain declarative English
and the present tense, with the answer or outcome in the first sentence. Use a table only to
compare things and a list only for separate items; give a long doc a TLDR. Name real files,
commands and settings, and refer to a settings page by its area rather than its exact path.

The same rules apply to UI copy, commit messages and PR descriptions: whole sentences, everyday
words, no hedging, no marketing, and no notes addressed to the team. Every tracked text file is
ASCII and YAML carries no comments. Prettier keeps the line breaks in Markdown, so wrap prose near
100 columns yourself.

## Releases and the changelog

`main` is the release line; there are no server release tags and no changelog file. An install
follows `origin/main` with `scripts/upgrade.sh`, which builds, backs up the database, restarts and
rolls back when the health check fails. Seti's What's new list shows the commits since the running
version, listing `feat`, `fix` and `perf` commits and leaving out dependency bumps. Because each PR
lands as one squashed commit, its title is its changelog entry.

Maintainers release the Android app with `pnpm android:release` to Firebase App Distribution, which
tags `android/v<version>-<n>`, and with `pnpm android:release --play` to Google Play, which tags
`android/play/v<version>-<n>`.

## License

Seti is licensed under the Apache License 2.0. A contribution submitted for inclusion is licensed
under the same terms, as section 5 of the license states.
