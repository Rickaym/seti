import type { ContextPack, Revision, Task } from '@seti/shared'
import { taskSsh } from '../agent-access.js'
import { taskAwsOutcome } from '../aws-access.js'
import { listContextFiles, readContextFile } from '../context-files.js'
import { tasks } from '../db.js'
import { taskMcpNames } from '../mcp-selection.js'
import { packForTask } from '../seti-guide.js'
import { channelSubscriptions } from '../store/channel-subscriptions.js'
import { taskContextPacks, contextPacks } from '../store/context.js'
import { revisions } from '../store/revisions.js'
import { teamDeliveries, teamMessages } from '../store/team.js'
import { ensureMember, teamMemberOf } from '../team.js'
import { CHAT_MESSAGES, type ChatView, type DeliveryLine } from './chat.js'
import { CONTEXT, MEMBERS, PACKS, TASK } from './dir.js'
import { loadRoster, renderMembers } from './members.js'
import { assignSlugs, renderPack, slugOf } from './objects.js'
import { renderTask } from './task-file.js'

const NOTES_SHOWN = 3
const NOTES_SCANNED = 500

/** A file as the platform's data renders it, and the state it shows, to spot stale copies. */
export interface Rendered {
  text: string
  stamp: string | null
}

/** A rendered file that stands for one pack or CLAUDE.md file, by id or key. */
export type RenderedObject = Rendered & { id: string }

/** Collapses concurrent loads of the roster, which every open workspace shows, into one. */
function shared<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null
  return async () => {
    pending ??= load().finally(() => {
      pending = null
    })
    return pending
  }
}

const loadMembers = shared(loadRoster)

function notesByObject(list: readonly Revision[]): Map<string, Revision[]> {
  const byObject = new Map<string, Revision[]>()
  for (const note of list) {
    const found = byObject.get(note.object_id) ?? []
    if (found.length < NOTES_SHOWN) {
      found.push(note)
    }
    byObject.set(note.object_id, found)
  }
  return byObject
}

export const loadPacks = async () => ({
  slugs: assignSlugs(await contextPacks.list(), 'pack'),
  notes: notesByObject(await revisions.notes('context_pack', NOTES_SCANNED)),
})

/** Where each CLAUDE.md file Seti manages appears in a workspace. */
export const contextEntries = async () =>
  (await listContextFiles()).map((file) => ({
    rel: file.key === 'user' ? `${CONTEXT}/CLAUDE.md` : `${CONTEXT}/${file.group}/${file.label}`,
    key: file.key,
    exists: file.exists,
  }))

const packRel = (slug: string) => `${PACKS}/${slug}.md`

export const packStamp = (pack: ContextPack, linked: boolean) =>
  JSON.stringify([pack.name, pack.description, pack.body, linked])

export async function membersFile(taskId: string): Promise<Rendered> {
  return { text: renderMembers(await loadMembers(), taskId), stamp: null }
}

async function taskAccessNames(task: Task) {
  const ssh = await taskSsh(task.id)
  return {
    ssh: ssh.usable,
    jumps: ssh.hosts.map((host) => host.alias).filter((alias) => !ssh.usable.includes(alias)),
    aws: await taskAwsOutcome(task),
  }
}

export async function taskFile(taskId: string): Promise<Rendered | null> {
  const task = await tasks.get(taskId)
  if (!task) {
    return null
  }
  const { slugs } = await loadPacks()
  const linked = await taskContextPacks.list(taskId)
  const role = linked.find((pack) => pack.kind === 'role')
  const view = {
    task,
    handle: (await ensureMember(task)).handle,
    packs: linked.flatMap((pack) => (pack.kind === 'role' ? [] : (slugOf(slugs, pack.id) ?? []))),
    role: role === undefined ? null : { name: role.name, slug: slugOf(slugs, role.id) ?? '' },
    channels: await channelSubscriptions.forTask(taskId),
    mcp: await taskMcpNames(taskId),
    access: await taskAccessNames(task),
  }
  return { text: renderTask(view), stamp: null }
}

export async function packFiles(taskId: string): Promise<Map<string, RenderedObject>> {
  const { slugs, notes } = await loadPacks()
  const linked = new Set((await taskContextPacks.list(taskId)).map((pack) => pack.id))
  const files = new Map<string, RenderedObject>()
  for (const [slug, stored] of slugs) {
    const pack = await packForTask(stored, taskId)
    const isLinked = linked.has(pack.id)
    const text = renderPack({ pack, linked: isLinked, notes: notes.get(pack.id) ?? [] })
    files.set(packRel(slug), { text, stamp: packStamp(pack, isLinked), id: pack.id })
  }
  return files
}

export async function contextFiles(): Promise<Map<string, RenderedObject>> {
  const files = new Map<string, RenderedObject>()
  for (const entry of (await contextEntries()).filter((found) => found.exists)) {
    const file = await readContextFile(entry.key)
    files.set(entry.rel, { text: file.content, stamp: file.hash, id: entry.key })
  }
  return files
}

/** The file as the platform's data renders it now, or null when it stands for nothing. */
export async function canonical(taskId: string, rel: string): Promise<Rendered | null> {
  if (rel === MEMBERS) {
    return membersFile(taskId)
  }
  if (rel === TASK) {
    return taskFile(taskId)
  }
  if (rel.startsWith(`${PACKS}/`)) {
    return (await packFiles(taskId)).get(rel) ?? null
  }
  return (await contextFiles()).get(rel) ?? null
}

export async function chatView(taskId: string): Promise<ChatView> {
  const member = await teamMemberOf(taskId)
  const list = await teamMessages.list({ kind: 'task', taskId }, CHAT_MESSAGES)
  const own = list.filter((m) => m.author_kind === 'task' && m.author_task_id === taskId).map((m) => m.id)
  const deliveries = new Map<number, DeliveryLine[]>()
  for (const row of await teamDeliveries.forMessages(own)) {
    deliveries.set(row.message_id, [...(deliveries.get(row.message_id) ?? []), row])
  }
  return { taskId, handle: member.handle, muted: member.muted, messages: list, deliveries }
}
