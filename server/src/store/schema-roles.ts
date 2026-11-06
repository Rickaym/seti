import { randomUUID } from 'node:crypto'
import { BUILTIN_ROLES, type AuditDetail } from '@seti/shared'
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

async function addBuiltinRoles(tx: Db, at: string): Promise<void> {
  const names = BUILTIN_ROLES.map((role) => role.name)
  await tx`UPDATE context_pack SET name = name || ' (yours)' WHERE name = ANY(${names})`
  for (const role of BUILTIN_ROLES) {
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
