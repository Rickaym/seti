import path from 'node:path'
import { contextPackInput, type ContextPack } from '@seti/shared'
import { asAgent } from '../access.js'
import { createPack, requirePack, saveContextFile, setTaskPacks, setTaskRole, updatePack } from '../context-changes.js'
import { readContextFile } from '../context-files.js'
import { tasks } from '../db.js'
import { HttpError } from '../http.js'
import { byAgent, type ChangeSource } from '../revisions.js'
import { packForTask } from '../seti-guide.js'
import { explain } from './files.js'
import { addNote } from './notes.js'
import { parseContextFile, parsePack, type PackEdit } from './objects.js'
import { loadPacks, packStamp } from './render.js'
import { taskContextPacks } from '../store/context.js'

/** What Seti did with an edit: applied it, put its own version back, or left the edit with a note. */
export type Outcome = { kind: 'applied' } | { kind: 'restore'; reason: string } | { kind: 'keep'; reason: string }

export interface Edit {
  taskId: string
  rel: string
  text: string
  /** The state the file showed when Seti last wrote it; undefined for a file Seti never wrote. */
  stamp: string | null | undefined
}

const APPLIED: Outcome = { kind: 'applied' }

const stale = (what: string): Outcome => ({
  kind: 'restore',
  reason: `the ${what} changed elsewhere since Seti wrote this file; read it again and redo your edit`,
})

const sameText = (a: string, b: string) => a.trim() === b.trim()

function source(edit: Edit, reason: string | undefined): ChangeSource {
  const why = reason?.trim() ?? ''
  return byAgent(edit.taskId, why === '' ? `Edited ${edit.rel} in the task workspace` : why)
}

/** Runs an edit as its agent, so it reaches no further than the agent's Seti control. */
async function guarded(taskId: string, work: () => Promise<Outcome>): Promise<Outcome> {
  const task = await tasks.get(taskId)
  if (!task) {
    return { kind: 'keep', reason: 'this agent is gone' }
  }
  try {
    return await asAgent(task, work)
  } catch (e) {
    const refused = e instanceof HttpError && e.status === 403
    return { kind: refused ? 'restore' : 'keep', reason: explain(e) }
  }
}

/** Links or unlinks a pack; linking a role pack replaces the agent's current role. */
async function setLinked(edit: Edit, pack: ContextPack, on: boolean, reason: string | undefined): Promise<void> {
  const task = await tasks.get(edit.taskId)
  if (!task) {
    return
  }
  if (pack.kind === 'role') {
    await setTaskRole(task, on ? pack.id : null, source(edit, reason))
    return
  }
  const ids = (await taskContextPacks.list(edit.taskId)).map((linked) => linked.id).filter((id) => id !== pack.id)
  await setTaskPacks(task, on ? [...ids, pack.id] : ids, source(edit, reason))
}

async function notePack(edit: Edit, packId: string, name: string, note: string | null): Promise<void> {
  if (note !== null) {
    await addNote(edit.taskId, { object_type: 'context_pack', object_id: packId }, `context pack "${name}"`, note)
  }
}

async function createPackFrom(edit: Edit, parsed: PackEdit): Promise<Outcome> {
  const input = contextPackInput.parse({
    name: parsed.name ?? path.basename(edit.rel, '.md'),
    description: parsed.description ?? '',
    body: parsed.body,
  })
  const created = (await createPack(input, parsed.kind ?? 'reference', source(edit, parsed.reason))).value
  if (parsed.linked === true) {
    await setLinked(edit, created, true, parsed.reason)
  }
  await notePack(edit, created.id, created.name, parsed.note)
  return APPLIED
}

async function updatePackFrom(edit: Edit, id: string, parsed: PackEdit): Promise<Outcome> {
  const current = await packForTask(await requirePack(id), edit.taskId)
  const linked = (await taskContextPacks.list(edit.taskId)).some((pack) => pack.id === id)
  if (packStamp(current, linked) !== edit.stamp) {
    return stale('pack')
  }
  if (parsed.kind !== undefined && parsed.kind !== current.kind) {
    return { kind: 'restore', reason: `a pack keeps its kind; write a new pack file with \`kind: ${parsed.kind}\`` }
  }
  const input = contextPackInput.parse({
    name: parsed.name ?? current.name,
    description: parsed.description ?? current.description,
    body: sameText(parsed.body, current.body) ? current.body : parsed.body,
  })
  const edited = input.name !== current.name || input.description !== current.description || input.body !== current.body
  if (current.builtin && (edited || parsed.note !== null)) {
    return { kind: 'restore', reason: `${current.name} is built into Seti; only its \`linked\` line changes` }
  }
  if (edited) {
    await updatePack(id, input, source(edit, parsed.reason))
  }
  if (parsed.linked !== undefined && parsed.linked !== linked) {
    await setLinked(edit, current, parsed.linked, parsed.reason)
  }
  await notePack(edit, id, input.name, parsed.note)
  return APPLIED
}

/** Applies a pack file: a new file creates a pack, an edit updates it and its link to the task. */
export async function applyPack(edit: Edit, packId: string | undefined): Promise<Outcome> {
  return guarded(edit.taskId, async () => {
    const notes = packId === undefined ? [] : ((await loadPacks()).notes.get(packId) ?? [])
    const parsed = parsePack(edit.text, notes)
    return packId === undefined ? createPackFrom(edit, parsed) : updatePackFrom(edit, packId, parsed)
  })
}

/** Writes a CLAUDE.md copy back to its file; `known` is false for a copy the agent created. */
export async function applyContext(edit: Edit, key: string, known: boolean): Promise<Outcome> {
  return guarded(edit.taskId, async () => {
    const current = await readContextFile(key)
    if (known && current.hash !== edit.stamp) {
      return stale('file')
    }
    const content = parseContextFile(edit.text)
    if (content !== current.content) {
      await saveContextFile(key, content, current.hash, source(edit, undefined))
    }
    return APPLIED
  })
}
