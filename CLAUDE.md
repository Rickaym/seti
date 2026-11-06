# Seti

Seti is a self-hosted control room for Claude Code agents that work on your repos. People read it
on a phone between other things, so every screen answers "what needs me?" first. This file holds
what every change must respect; CONTRIBUTING.md has the workflow, the recipes and the security
checklist.

## Principles

- Least privilege by default, because anyone who drives Seti's API can run commands as its user.
  Agents run sandboxed with no keys or tokens inside; the egress proxy adds a connection's value
  on its hosts only. New access starts off, and an off or least-privilege state is normal, never
  styled as an error.
- Security settings, credentials and connections stay the user's, because they decide what every
  agent can reach. A credential is the bundle an agent picks; a connection is one service's access
  it carries. The EA and agents' Seti tools never change them, never see a value and never create
  share links; the server refuses them (`server/src/ea-guard.ts`), not just the tool list. Agents
  may propose a change with `request_change` (a host, a connection without its value, an MCP
  server); only the user's own Allow applies it, and the approve route refuses the EA and agents.
- Every other platform action gets an EA tool in the same PR, because the EA is the hands-free way
  to run Seti. The EA has a 128-tool cap, so extend an existing tool before adding one.
- Public surfaces stay minimal, because they face the internet without a login: exact anchored
  paths, handlers that read only the database, rate limits, and served pages with no script.
- Secrets never land in logs, transcripts, audit details or chat, because those get read, copied
  and shared. Record that a secret changed, never its value.
- Every change is audited, because the audit log is a verified hash chain the user relies on to
  see what agents, the EA and Seti itself did.
- Every flow works on a phone, full configuration included, because the phone is where people
  triage and reply.
- Keep the code pristine, because the gates only stay strict while nothing is excused: delete dead
  code, split what grows too large, and leave no workaround behind.
- Stay neutral and configurable, because Seti runs on other people's machines: no hard-coded
  people, hosts, home paths or repo slugs in code, prompts, docs or fixtures.
- No is an acceptable answer, because every addition costs UI, tools and review. Push back when an
  addition does not earn its place; agreement is not the default.
- Explain before you enforce: asked why something happens, find and report the cause before adding
  a block, a guard or a hook.

## Hard rules

Workflow and gates:

- Run `pnpm check` before every push, and the e2e specs your change touches
  (`pnpm build && pnpm e2e <spec name>`). CI runs the same gates; `main` accepts only passing PRs.
- Node 24 and pnpm (corepack). Never bypass hooks with `--no-verify`.
- Work on a feature branch and open a PR; never commit to `main` and never force-push a branch
  others use. Merges are squash-only, so the PR title becomes the commit on `main` and the What's
  new entry: write it as a conventional commit (`feat(terminal): ...`).
- Resolving a review thread is part of fixing it.

Code:

- Request and response shapes live in `shared/src/<area>.ts`, re-exported from `shared/src/index.ts`.
  Validate every request body with its zod schema.
- SQL lives in `server/src/db.ts` (core tables) and `server/src/store/<area>.ts`; routes call typed
  functions, never `db.prepare` directly.
- A schema change is a new entry at the end of `MIGRATIONS` in `server/src/store/schema.ts`; never
  edit a migration that has shipped.
- Start tasks through `startTask` in `server/src/tasks.ts`. Add system prompt context for a task with
  `registerContextProvider` from `server/src/runner.ts`, registered in `createApp`.
- No `any`, no non-null assertions, no default exports, no enums. Lint disables need a description.
- Files stay under 400 lines and functions under complexity 15; split them rather than disable the
  rule.
- Delete dead code instead of leaving it; knip fails on unused files, exports and dependencies.
- UI components come from `ui/src/components/ui` (shadcn). Add new ones with the shadcn CLI, then
  bring them to the repo's lint standard. shadcn is not a dependency, so run it as
  `pnpm dlx shadcn@4.21.0 add <component>` from `ui/`.
- Colours come from the theme tokens in `ui/src/components/theme/themes/`, never raw colours.
- Run programs with an argument list and no shell. Remove folders only through
  `server/src/owned-dirs.ts`.

UI:

- Labels are one or two words with a lucide icon; detail goes in a tooltip. Binary modes are
  toggles, not selects.
- Failure toasts stay until dismissed. No single-key shortcuts outside the opt-in Vim mode; Esc and
  modifier combos are fine.
- Needs you holds only agents that cannot go on without the user, each with a reason line; the
  status bar shows one "N need you" item. A red CI run shows on the PR, not in Needs you.
- Restart, Fresh and Archive live in the footer of the agent's settings, each with its consequence.
- A UI change gets a phone spec (`e2e/tests/<name>.phone.spec.ts`) beside its desktop spec.

Writing:

- Put the answer or outcome first. Use whole sentences, everyday words and the real names of files,
  commands and settings.
- Write a comment only where the code is not self-evident: one line, ASCII, under 100 characters,
  never a block. No comments in YAML or CI workflows. Every tracked text file is ASCII.
- Text an outside reader sees (UI copy, docs, commit messages, PR descriptions) carries no internal
  notes, placeholders or provenance.

Shell and host:

- Use bash for scripts and quote every variable. Never `rm -rf` a path built from variables.
- Never kill processes by name or pattern; stop exact PIDs.
- Never sleep or poll for longer than 270 seconds, since the prompt cache lasts five minutes. Run
  long commands in the background and end the turn.
- Never generate synthetic CPU load. Respect your CPU and memory caps, and size build and test
  workers to the cores your system prompt names.

## Where things live

- `server/src/routes/<area>.ts`: Hono routes, mounted in `server/src/app.ts`.
- `server/src/store/`: SQL, with `schema-<area>.ts` and the `MIGRATIONS` list in `schema.ts`.
- `server/src/seti-tools/`: the Seti tools agents get by Seti control level (`levels.ts`);
  `parity.test.ts` holds the Full set to the EA's.
- `shared/src/`: zod schemas and types both sides use.
- `ui/src/panels/`: views; settings pages are in `ui/src/panels/settings/`, listed in `pages.ts`.
- `ea/src/seti_ea/`: the Executive Assistant (Python); its tools are in `*_tools.py`, `tools.py`
  and `actions.py`, and writes pass `gate.py`.
- `mods/<id>/`: bundled mods, which import only `@seti/mod-api` (`packages/mod-api/`); the mod host
  and its registries are in `server/src/mods/`.
- `e2e/tests/`: Playwright specs, with fakes for Claude, `gh` and the planner in `support/`.
- `docs/`: setup, architecture, security and pollers. Update them in the PR that changes behaviour.
