import type {
  AuditKind,
  ContextFileContent,
  ContextPack,
  ContextPackSummary,
  PackKind,
  RevisionState,
  Task,
} from '@seti/shared'
import { audit } from './audit.js'
import { readContextFile, writeContextFile } from './context-files.js'
import { refuseAtSelf, refuseOtherAgent } from './ea-guard.js'
import { HttpError } from './http.js'
import { byUser, recordRevision, sourceDetail, type ChangeSource, type Saved } from './revisions.js'
import { packForDisplay } from './seti-guide.js'
import { contextPacks, eaContextPacks, taskContextPacks } from './store/context.js'
import { signalWorkspaces } from './workspace/dir.js'

type PackFields = Pick<ContextPack, 'name' | 'description' | 'body'>

export async function requirePack(id: string): Promise<ContextPack> {
  const pack = await contextPacks.get(id)
  if (!pack) {
    throw new HttpError(404, 'Context pack not found')
  }
  return pack
}

/** Seti renders the built-in pack itself, so nobody edits or deletes it. */
function refuseBuiltin(pack: ContextPack, verb: 'changed' | 'deleted'): void {
  if (pack.builtin) {
    throw new HttpError(403, `${pack.name} is built into Seti and cannot be ${verb}; unlink it instead`)
  }
}

/** Links the pack to every task without its own choice, or stops doing so. */
export async function setPackLinkedByDefault(id: string, on: boolean): Promise<ContextPack> {
  const before = await requirePack(id)
  if (before.linked_by_default === on) {
    return before
  }
  if (before.kind === 'role') {
    throw new HttpError(400, `${before.name} is a role pack; roles are picked per agent, never linked by default`)
  }
  await contextPacks.setLinkedByDefault(id, on)
  const pack = await requirePack(id)
  await audit.record({
    actor: 'user',
    kind: 'context.pack_default_changed',
    subject_type: 'context_pack',
    subject_id: id,
    summary: `${on ? 'Linked' : 'Unlinked'} context pack "${pack.name}" by default for agents without their own choice`,
    detail: { name: pack.name, linked_by_default: on },
  })
  signalWorkspaces('packs')
  return pack
}

export const packState = (pack: ContextPack): RevisionState => ({
  name: pack.name,
  description: pack.description,
  body: pack.body,
})

const packRef = (id: string) => ({ object_type: 'context_pack', object_id: id }) as const

const PACK_VERBS = {
  'context.pack_created': 'Created',
  'context.pack_updated': 'Updated',
  'context.pack_deleted': 'Deleted',
  'seti.context_pack_created': 'Agent created',
  'seti.context_pack_updated': 'Agent updated',
} as const satisfies Partial<Record<AuditKind, string>>

type PackEvent = keyof typeof PACK_VERBS

async function auditPack(
  kind: PackEvent,
  pack: Pick<ContextPack, 'id' | 'name' | 'body'>,
  source: ChangeSource = byUser(),
  revision: number | null = null,
): Promise<void> {
  const reason = source.actor === 'agent' && source.reason !== null ? `: ${source.reason}` : ''
  await audit.record({
    actor: source.actor,
    kind,
    subject_type: 'context_pack',
    subject_id: pack.id,
    summary: `${PACK_VERBS[kind]} context pack "${pack.name}"${reason}`,
    detail: { name: pack.name, bytes: Buffer.byteLength(pack.body, 'utf8'), ...sourceDetail(source, revision) },
  })
}

const byAgentOr = (source: ChangeSource, user: PackEvent, agent: PackEvent) => (source.actor === 'agent' ? agent : user)

export async function createPack(
  fields: PackFields,
  kind: PackKind = 'reference',
  source: ChangeSource = byUser(),
): Promise<Saved<ContextPack>> {
  refuseAtSelf('create context packs')
  const pack = await contextPacks.create(fields, kind)
  const revision = await recordRevision(source, packRef(pack.id), null, packState(pack))
  await auditPack(byAgentOr(source, 'context.pack_created', 'seti.context_pack_created'), pack, source, revision)
  signalWorkspaces('packs')
  return { value: pack, revision }
}

export async function updatePack(
  id: string,
  fields: PackFields,
  source: ChangeSource = byUser(),
): Promise<Saved<ContextPack>> {
  refuseAtSelf('change context packs other agents read')
  const before = await requirePack(id)
  refuseBuiltin(before, 'changed')
  await contextPacks.update(id, fields)
  const pack = await requirePack(id)
  const revision = await recordRevision(source, packRef(id), packState(before), packState(pack))
  if (revision !== null || source.actor === 'user') {
    await auditPack(byAgentOr(source, 'context.pack_updated', 'seti.context_pack_updated'), pack, source, revision)
  }
  signalWorkspaces('packs')
  return { value: pack, revision }
}

/** Deletes a pack, never the built-in guide; a pack already gone is no error. */
export async function deletePack(id: string): Promise<void> {
  const pack = await contextPacks.get(id)
  if (pack === undefined) {
    return
  }
  refuseBuiltin(pack, 'deleted')
  if (await contextPacks.remove(pack.id)) {
    await auditPack('context.pack_deleted', pack)
    signalWorkspaces('packs')
  }
}

/** An editable copy of a pack, built-in roles included, as the agents read it; not the guide. */
export async function duplicatePack(id: string): Promise<Saved<ContextPack>> {
  const pack = packForDisplay(await requirePack(id))
  if (pack.builtin && pack.kind === 'reference') {
    throw new HttpError(400, `${pack.name} is written by Seti for each agent and cannot be copied`)
  }
  const name = await contextPacks.copyName(pack.name)
  return createPack({ name, description: pack.description, body: pack.body }, pack.kind)
}

const fileState = (file: ContextFileContent): RevisionState | null => (file.exists ? { content: file.content } : null)

/** Writes a CLAUDE.md file while it still hashes to baseHash; records audit and revision. */
export async function saveContextFile(
  key: string,
  content: string,
  baseHash: string | null,
  source: ChangeSource = byUser(),
): Promise<Saved<ContextFileContent>> {
  refuseAtSelf('change CLAUDE.md files other agents read')
  const before = await readContextFile(key)
  const file = await writeContextFile(key, content, baseHash)
  const ref = { object_type: 'context_file', object_id: file.key } as const
  const revision = await recordRevision(source, ref, fileState(before), { content: file.content })
  const agent = source.actor === 'agent'
  await audit.record({
    actor: source.actor,
    kind: agent ? 'seti.context_file_saved' : 'context.file_saved',
    subject_type: 'context_file',
    subject_id: file.key,
    summary: `${agent ? 'Agent saved' : 'Saved'} ${file.path} (${String(file.size ?? 0)} bytes)${
      agent ? `: ${source.reason ?? ''}` : ''
    }`,
    detail: { key: file.key, path: file.path, bytes: file.size, ...sourceDetail(source, agent ? revision : null) },
  })
  signalWorkspaces('context')
  return { value: file, revision }
}

/** Replaces the packs attached to a task; records an audit event when the set changed. */
export async function setTaskPacks(
  task: Task,
  packIds: readonly string[],
  source: ChangeSource = byUser(),
): Promise<ContextPackSummary[]> {
  refuseOtherAgent(task.id)
  await contextPacks.assertLinkable(packIds)
  const before = (await taskContextPacks.list(task.id)).map((pack) => pack.name)
  await taskContextPacks.set(task.id, packIds)
  const after = await taskContextPacks.list(task.id)
  signalWorkspaces('packs', task.id)
  signalWorkspaces('members')
  const names = after.map((pack) => pack.name)
  if (names.join('\n') !== before.join('\n')) {
    await audit.record({
      actor: source.actor,
      kind: source.actor === 'agent' ? 'seti.task_context_packs_changed' : 'task.context_packs_changed',
      subject_type: 'task',
      subject_id: task.id,
      summary: `Context packs of "${task.title}": ${names.length === 0 ? 'none' : names.join(', ')}`,
      detail: { title: task.title, before, after: names, ...sourceDetail(source, null) },
    })
  }
  return after
}

/** The Seti guide is written for agents in their workspaces; the EA has a prompt of its own. */
async function refuseGuideForEa(packIds: readonly string[]): Promise<void> {
  const packs = await Promise.all(packIds.map(requirePack))
  const guide = packs.find((pack) => pack.builtin && pack.kind === 'reference')
  if (guide !== undefined) {
    throw new HttpError(400, `${guide.name} is written for agents; the EA has a prompt of its own`)
  }
}

async function auditEaPacks(
  before: readonly ContextPackSummary[],
  after: readonly ContextPackSummary[],
  role: boolean,
) {
  const names = (packs: readonly ContextPackSummary[]) =>
    packs.filter((pack) => (pack.kind === 'role') === role).map((pack) => pack.name)
  const [prior, next] = [names(before), names(after)]
  if (prior.join('\n') === next.join('\n')) {
    return
  }
  const list = next.length === 0 ? 'none' : next.join(', ')
  await audit.record({
    actor: 'user',
    kind: 'ea.context_packs_changed',
    subject_type: 'ea',
    summary: role ? `Role of the EA: ${list}` : `Context packs of the EA: ${list}`,
    detail: { pack_kind: role ? 'role' : 'reference', before: prior, after: next },
  })
}

/** Links exactly these packs to the EA, at most one of them a role; audits what changed. */
export async function setEaPacks(packIds: readonly string[]): Promise<ContextPackSummary[]> {
  await contextPacks.assertLinkable(packIds)
  await refuseGuideForEa(packIds)
  const before = await eaContextPacks.summaries()
  await eaContextPacks.set(packIds)
  const after = await eaContextPacks.summaries()
  await auditEaPacks(before, after, true)
  await auditEaPacks(before, after, false)
  return after
}

/** Links a role pack to the EA in place of its current one, or with null removes its role. */
export async function setEaRole(packId: string | null): Promise<ContextPackSummary[]> {
  const pack = packId === null ? null : await requirePack(packId)
  if (pack !== null && pack.kind !== 'role') {
    throw new HttpError(400, `${pack.name} is a reference pack, not a role; link it under Context instead`)
  }
  const before = await eaContextPacks.summaries()
  if ((before.find((linked) => linked.kind === 'role')?.id ?? null) === packId) {
    return before
  }
  await eaContextPacks.setRole(packId)
  const after = await eaContextPacks.summaries()
  await auditEaPacks(before, after, true)
  return after
}

const roleOf = async (taskId: string) => (await taskContextPacks.list(taskId)).find((pack) => pack.kind === 'role')

/** Links a role pack in place of the agent's current one, or with null removes its role. */
export async function setTaskRole(
  task: Task,
  packId: string | null,
  source: ChangeSource = byUser(),
): Promise<ContextPackSummary[]> {
  refuseOtherAgent(task.id)
  const pack = packId === null ? null : await requirePack(packId)
  if (pack !== null && pack.kind !== 'role') {
    throw new HttpError(400, `${pack.name} is a reference pack, not a role; link it under Access instead`)
  }
  const before = await roleOf(task.id)
  if ((before?.id ?? null) === packId) {
    return taskContextPacks.list(task.id)
  }
  await taskContextPacks.setRole(task.id, packId)
  signalWorkspaces('packs', task.id)
  signalWorkspaces('members')
  await audit.record({
    actor: source.actor,
    kind: source.actor === 'agent' ? 'seti.task_context_packs_changed' : 'task.context_packs_changed',
    subject_type: 'task',
    subject_id: task.id,
    summary: `Role of "${task.title}": ${pack?.name ?? 'none'}`,
    detail: {
      title: task.title,
      pack_kind: 'role',
      before: before === undefined ? [] : [before.name],
      after: pack === null ? [] : [pack.name],
      ...sourceDetail(source, null),
    },
  })
  return taskContextPacks.list(task.id)
}
