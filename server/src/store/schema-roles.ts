import { randomUUID } from 'node:crypto'
import type { AuditDetail } from '@seti/shared'
import type { Db } from '../pg.js'

export const PACK_KIND = `
ALTER TABLE context_pack ADD COLUMN kind TEXT NOT NULL DEFAULT 'reference' CHECK (kind IN ('reference', 'role'));
`

const NAME_MAX = 80
const SUFFIX = ' role'

/** "<title> role" within the name limit, numbered past names already taken. */
export function rolePackName(title: string, taken: ReadonlySet<string>): string {
  for (let n = 1; ; n += 1) {
    const tail = n === 1 ? SUFFIX : `${SUFFIX} ${String(n)}`
    const name = `${title
      .trim()
      .slice(0, NAME_MAX - tail.length)
      .trimEnd()}${tail}`
    if (!taken.has(name)) {
      return name
    }
  }
}

interface RetiredRole {
  id: string
  name: string
  description: string
  /** What an agent read in the role; a role retireBuiltinRoles keeps takes it as its body. */
  text: string
}

/** The roles Seti shipped once: roles_as_packs seeds them and retireBuiltinRoles retires them. */
export const RETIRED_ROLES: readonly RetiredRole[] = [
  {
    id: '5e710000-0000-4000-8000-000000000002',
    name: 'Lead',
    description: 'Runs a stream of work and delegates it instead of implementing it',
    text: [
      'Lead: you run a stream of work and delegate it; you are not its implementer.',
      '- Break each request into pieces, each with an owner and a definition of done.',
      '- Hand implementation to background subagents (Agent tool, run_in_background: true); without them, to helper agents with start_task, or ask @ea in chat.md to start them.',
      '- For a larger stream of work, ask @ea in chat.md to start a dedicated Seti agent for it.',
      '- Track what you handed out; review results and PRs before you call anything done.',
      '- Keep the user informed concisely: decisions, blockers and outcomes.',
      '- Make a small edit yourself only when delegating it costs more.',
    ].join('\n'),
  },
  {
    id: '5e710000-0000-4000-8000-000000000003',
    name: 'Reviewer',
    description: "Reviews PRs and other agents' work without building it",
    text: [
      "Reviewer: you review PRs and other agents' work; you do not build it.",
      '- Read the diff, run the checks and compare the result with what was asked.',
      '- Request changes from the author, by @handle in chat.md or in a PR review, with concrete fixes.',
      '- Approve only what you would merge yourself.',
      '- Never implement large changes yourself; hand them back to their owner.',
    ].join('\n'),
  },
  {
    id: '5e710000-0000-4000-8000-000000000004',
    name: 'Watcher',
    description: 'Monitors channels, pollers and CI and routes what needs action',
    text: [
      'Watcher: you monitor channels, pollers and CI and route what needs action.',
      '- Triage each event: drop noise, act on what matters.',
      '- Route an issue by @handle in chat.md to the agent that owns it, or to @ea when none does.',
      '- Act directly only on trivial fixes, such as rerunning a flaky job.',
      '- Post one short line per issue: what happened, where, and who has it.',
    ].join('\n'),
  },
]

async function addBuiltinRoles(tx: Db, at: string): Promise<void> {
  const names = RETIRED_ROLES.map((role) => role.name)
  await tx`UPDATE context_pack SET name = name || ' (yours)' WHERE name = ANY(${names})`
  for (const role of RETIRED_ROLES) {
    await tx`INSERT INTO context_pack (id, name, description, body, kind, builtin, linked_by_default, created_at,
        updated_at)
      VALUES (${role.id}, ${role.name}, ${role.description}, '', 'role', true, false, ${at}, ${at})`
  }
}

/** Seeds the built-in roles, moves each agent's role text into a role pack linked to it. */
export async function rolesToPacks(tx: Db): Promise<void> {
  const at = new Date().toISOString()
  await addBuiltinRoles(tx, at)
  const taken = new Set((await tx<{ name: string }[]>`SELECT name FROM context_pack`).map((row) => row.name))
  const roles = await tx<{ id: string; title: string; role: string }[]>`SELECT id, title, role FROM task
    WHERE role IS NOT NULL ORDER BY created_at, id`
  const moved: string[] = []
  for (const task of roles) {
    const name = rolePackName(task.title, taken)
    taken.add(name)
    const id = randomUUID()
    await tx`INSERT INTO context_pack (id, name, description, body, kind, created_at, updated_at)
      VALUES (${id}, ${name}, '', ${task.role}, 'role', ${at}, ${at})`
    await tx`INSERT INTO task_context_pack (task_id, pack_id, linked) VALUES (${task.id}, ${id}, true)`
    moved.push(`${task.id}: ${name} (${id})`)
  }
  await tx`ALTER TABLE task DROP COLUMN role`
  if (moved.length === 0) {
    return
  }
  const detail: AuditDetail = { packs: moved }
  const summary = `Moved the roles of ${String(moved.length)} agents into role packs linked to them`
  await tx`INSERT INTO audit_event (at, actor, kind, subject_type, subject_id, summary, detail)
    VALUES (${at}, 'system', 'system.roles_migrated', 'system', NULL, ${summary}, ${JSON.stringify(detail)})`
}

/** The runtime and model an agent started in a role takes, unless its start names its own. */
export const ROLE_RUNTIME = `
ALTER TABLE context_pack ADD COLUMN runtime TEXT, ADD COLUMN model TEXT;
`

/** Whether a retired role is in use: linked anywhere, named by a mod grant, or given a runtime. */
const usedRoles = async (tx: Db, ids: readonly string[]) =>
  tx<{ id: string; name: string }[]>`SELECT p.id, p.name FROM context_pack p WHERE p.id = ANY(${[...ids]})
    AND p.builtin AND (p.runtime IS NOT NULL OR p.model IS NOT NULL
      OR EXISTS (SELECT 1 FROM task_context_pack tp WHERE tp.pack_id = p.id AND tp.linked)
      OR EXISTS (SELECT 1 FROM ea_context_pack ep WHERE ep.pack_id = p.id)
      OR EXISTS (SELECT 1 FROM credential_access ca WHERE ca.kind = 'pack' AND ca.item = p.id)
      OR EXISTS (SELECT 1 FROM mod_grant g, jsonb_array_elements_text(CASE
          WHEN jsonb_typeof(g.capability -> 'agents') = 'array' THEN g.capability -> 'agents' ELSE '[]' END) a
        WHERE lower(a) = 'role:' || lower(p.name)))
    ORDER BY p.name`

/** Keeps used built-in roles as the user's own, deletes the rest; a new install records nothing. */
export async function retireBuiltinRoles(tx: Db): Promise<void> {
  const at = new Date().toISOString()
  const ids = RETIRED_ROLES.map((role) => role.id)
  const kept = await usedRoles(tx, ids)
  for (const { id } of kept) {
    const text = RETIRED_ROLES.find((role) => role.id === id)?.text ?? ''
    await tx`UPDATE context_pack SET builtin = false, body = ${text}, updated_at = ${at} WHERE id = ${id}`
  }
  const removed = await tx<{ name: string }[]>`DELETE FROM context_pack WHERE id = ANY(${ids}) AND builtin
    RETURNING name`
  const [history] = await tx<{ any: boolean }[]>`SELECT EXISTS (SELECT 1 FROM audit_event) AS any`
  if (kept.length + removed.length === 0 || (kept.length === 0 && history?.any !== true)) {
    return
  }
  const names = (rows: readonly { name: string }[]) =>
    rows.map((row) => row.name).toSorted((a, b) => a.localeCompare(b))
  const listed = (rows: readonly { name: string }[]) => (rows.length === 0 ? 'none' : names(rows).join(', '))
  const detail: AuditDetail = { kept: names(kept), removed: names(removed) }
  const summary = `Seti ships no built-in roles: kept ${listed(kept)} as your own, removed ${listed(removed)}`
  await tx`INSERT INTO audit_event (at, actor, kind, subject_type, subject_id, summary, detail)
    VALUES (${at}, 'system', 'system.roles_migrated', 'system', NULL, ${summary}, ${JSON.stringify(detail)})`
}
