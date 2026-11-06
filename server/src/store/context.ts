import { randomUUID } from 'node:crypto'
import type { ContextPack, ContextPackLinks, ContextPackSummary, PackKind } from '@seti/shared'
import { now, sql, transaction } from '../db.js'
import { HttpError } from '../http.js'

type PackFields = Pick<ContextPack, 'name' | 'description' | 'body'>

const getPack = async (id: string) => (await sql<ContextPack[]>`SELECT * FROM context_pack WHERE id = ${id}`).at(0)

/**
 * The packs linked to a task: its own link or unlink, else the pack's default. Built-in packs'
 * bodies are left for Seti to render.
 */
export const packsOfTask = async (taskId: string) =>
  sql<ContextPack[]>`SELECT p.* FROM context_pack p
    LEFT JOIN task_context_pack tp ON tp.pack_id = p.id AND tp.task_id = ${taskId}
    WHERE COALESCE(tp.linked, p.linked_by_default) ORDER BY lower(p.name)`

async function assertNameFree(name: string, id: string | null): Promise<void> {
  const [existing] = await sql<Pick<ContextPack, 'id'>[]>`SELECT id FROM context_pack WHERE name = ${name}`
  if (existing && existing.id !== id) {
    throw new HttpError(409, `A context pack named "${name}" already exists`)
  }
}

export const contextPacks = {
  list: async () => [...(await sql<ContextPack[]>`SELECT * FROM context_pack ORDER BY lower(name)`)],
  get: getPack,
  create: async (fields: PackFields, kind: PackKind = 'reference'): Promise<ContextPack> => {
    await assertNameFree(fields.name, null)
    const ts = now()
    const pack: ContextPack = {
      ...fields,
      id: randomUUID(),
      kind,
      builtin: false,
      linked_by_default: false,
      created_at: ts,
      updated_at: ts,
    }
    await sql`INSERT INTO context_pack (id, name, description, body, kind, created_at, updated_at)
      VALUES (${pack.id}, ${pack.name}, ${pack.description}, ${pack.body}, ${pack.kind}, ${pack.created_at},
        ${pack.updated_at})`
    return pack
  },
  /** The first of "<name> (copy)", "<name> (copy 2)" and so on that no pack has. */
  copyName: async (name: string): Promise<string> => {
    const taken = new Set((await sql<{ name: string }[]>`SELECT name FROM context_pack`).map((row) => row.name))
    for (let n = 1; ; n += 1) {
      const tail = n === 1 ? ' (copy)' : ` (copy ${String(n)})`
      const copy = `${name.slice(0, 80 - tail.length)}${tail}`
      if (!taken.has(copy)) {
        return copy
      }
    }
  },
  update: async (id: string, fields: PackFields): Promise<ContextPack | undefined> => {
    await assertNameFree(fields.name, id)
    await sql`UPDATE context_pack SET name = ${fields.name}, description = ${fields.description},
      body = ${fields.body}, updated_at = ${now()} WHERE id = ${id}`
    return getPack(id)
  },
  setLinkedByDefault: async (id: string, on: boolean) => {
    await sql`UPDATE context_pack SET linked_by_default = ${on}, updated_at = ${now()} WHERE id = ${id}`
  },
  /** The packs every task without its own choice gets. */
  linkedByDefault: async () =>
    (await sql<{ id: string }[]>`SELECT id FROM context_pack WHERE linked_by_default ORDER BY lower(name)`).map(
      (row) => row.id,
    ),
  remove: async (id: string) => (await sql`DELETE FROM context_pack WHERE id = ${id} AND NOT builtin`).count > 0,
  /** Every id names a pack and at most one is a role pack; 400 otherwise. */
  assertLinkable: async (ids: readonly string[]): Promise<void> => {
    const found = await sql<Pick<ContextPack, 'id' | 'name' | 'kind'>[]>`SELECT id, name, kind FROM context_pack
      WHERE id = ANY(${[...ids]}) ORDER BY lower(name)`
    const missing = ids.find((id) => !found.some((pack) => pack.id === id))
    if (missing !== undefined) {
      throw new HttpError(400, `Unknown context pack ${missing}`)
    }
    const roles = found.filter((pack) => pack.kind === 'role').map((pack) => pack.name)
    if (roles.length > 1) {
      throw new HttpError(400, `An agent takes one role pack, not ${roles.join(' and ')}`)
    }
  },
}

/** A task's pack links as overrides: true links a pack off by default, false unlinks one on. */
export const taskContextPacks = {
  list: async (taskId: string): Promise<ContextPackSummary[]> =>
    (await packsOfTask(taskId)).map(({ id, name, kind }) => ({ id, name, kind })),
  choices: async (taskId: string): Promise<Record<string, boolean>> =>
    Object.fromEntries(
      (
        await sql<{ pack_id: string; linked: boolean }[]>`SELECT pack_id, linked FROM task_context_pack
          WHERE task_id = ${taskId} ORDER BY pack_id`
      ).map((row) => [row.pack_id, row.linked]),
    ),
  /** Links exactly these packs, storing only where that differs from each pack's default. */
  set: async (taskId: string, packIds: readonly string[]): Promise<void> => {
    await transaction(async (tx) => {
      await tx`DELETE FROM task_context_pack WHERE task_id = ${taskId}`
      await tx`INSERT INTO task_context_pack (task_id, pack_id, linked)
        SELECT ${taskId}, p.id, p.id = ANY(${[...packIds]}) FROM context_pack p
        WHERE (p.id = ANY(${[...packIds]})) <> p.linked_by_default`
    })
  },
  setOne: async (taskId: string, packId: string, linked: boolean | null): Promise<void> => {
    if (linked === null) {
      await sql`DELETE FROM task_context_pack WHERE task_id = ${taskId} AND pack_id = ${packId}`
      return
    }
    await sql`INSERT INTO task_context_pack (task_id, pack_id, linked) VALUES (${taskId}, ${packId}, ${linked})
      ON CONFLICT (task_id, pack_id) DO UPDATE SET linked = excluded.linked`
  },
  /** Links this role pack in place of the task's current one, or with null leaves it none. */
  setRole: async (taskId: string, packId: string | null): Promise<void> => {
    await transaction(async (tx) => {
      await tx`DELETE FROM task_context_pack tp USING context_pack p
        WHERE tp.pack_id = p.id AND tp.task_id = ${taskId} AND p.kind = 'role'`
      if (packId !== null) {
        await tx`INSERT INTO task_context_pack (task_id, pack_id, linked) VALUES (${taskId}, ${packId}, true)`
      }
    })
  },
}

/** The packs the user links to the EA: none by default, since linked_by_default is for agents. */
export const eaContextPacks = {
  /** Its role pack first, then its reference packs by name. */
  list: async (): Promise<ContextPack[]> => [
    ...(await sql<ContextPack[]>`SELECT p.* FROM context_pack p JOIN ea_context_pack e ON e.pack_id = p.id
      ORDER BY e.role DESC, lower(p.name)`),
  ],
  summaries: async (): Promise<ContextPackSummary[]> =>
    (await eaContextPacks.list()).map(({ id, name, kind }) => ({ id, name, kind })),
  /** Links exactly these packs; the caller checks that at most one is a role pack. */
  set: async (packIds: readonly string[]): Promise<void> => {
    await transaction(async (tx) => {
      await tx`DELETE FROM ea_context_pack`
      await tx`INSERT INTO ea_context_pack (pack_id, role, linked_at)
        SELECT id, kind = 'role', ${now()} FROM context_pack WHERE id = ANY(${[...packIds]})`
    })
  },
  /** Links this role pack in place of the EA's current one, or with null leaves it none. */
  setRole: async (packId: string | null): Promise<void> => {
    await transaction(async (tx) => {
      await tx`DELETE FROM ea_context_pack WHERE role`
      if (packId !== null) {
        await tx`INSERT INTO ea_context_pack (pack_id, role, linked_at) VALUES (${packId}, true, ${now()})`
      }
    })
  },
}

/** The unarchived agents that read a pack, by their own link or its default, and the EA. */
export async function packLinks(pack: Pick<ContextPack, 'id' | 'linked_by_default'>): Promise<ContextPackLinks> {
  const agents = await sql<ContextPackLinks['agents']>`SELECT t.id, t.title FROM task t
    LEFT JOIN task_context_pack tp ON tp.task_id = t.id AND tp.pack_id = ${pack.id}
    WHERE t.archived_at IS NULL AND COALESCE(tp.linked, ${pack.linked_by_default})
    ORDER BY lower(t.title), t.id`
  const [ea] = await sql<{ linked: boolean }[]>`SELECT EXISTS (SELECT 1 FROM ea_context_pack
    WHERE pack_id = ${pack.id}) AS linked`
  return { agents: [...agents], ea: ea?.linked ?? false }
}

/** Each task's linked role pack, for the rosters that name agents' roles. */
export const rolePacksByTask = async (): Promise<Map<string, ContextPack>> =>
  new Map(
    (
      await sql<(ContextPack & { task_id: string })[]>`SELECT p.*, tp.task_id FROM task_context_pack tp
        JOIN context_pack p ON p.id = tp.pack_id WHERE tp.linked AND p.kind = 'role'`
    ).map(({ task_id, ...pack }) => [task_id, pack]),
  )
