import {
  changedKeys,
  knowledgeFields,
  type ApproveKnowledge,
  type KnowledgeFields,
  type KnowledgeNote,
  type KnowledgeSource,
  type KnowledgeStatus,
  type RevisionState,
} from '@seti/shared'
import { audit } from './audit.js'
import { fromEa, refuseAgent } from './ea-guard.js'
import { describeIssues, HttpError } from './http.js'
import { checkFields } from './knowledge.js'
import { byUser, recordRevision, sourceDetail, type ChangeSource } from './revisions.js'
import { knowledge } from './store/knowledge.js'

/** What the user alone does with notes; the EA, agents and mods are refused in the core. */
export const KNOWLEDGE_REVIEW = 'approve, reject or edit knowledge notes'

/** Approval is the user's alone, because an approved note reaches every agent's system prompt. */
function refuseDelegateReview(): void {
  refuseAgent(KNOWLEDGE_REVIEW)
  if (fromEa()) {
    throw new HttpError(403, `The EA cannot ${KNOWLEDGE_REVIEW}; the user does that in Seti`)
  }
}

const sourceText = (source: KnowledgeSource) => `${source.kind}: ${source.ref}`

/** A note's fields as a revision stores them; sources as "kind: ref" lines. */
const noteState = (note: KnowledgeFields): RevisionState => ({
  kind: note.kind,
  title: note.title,
  body: note.body,
  verify: note.verify,
  sources: note.sources.map(sourceText),
  repo_id: note.repo_id,
})

const ref = (id: string) => ({ object_type: 'knowledge_note', object_id: id }) as const

/** Shown to agents, so its revisions are kept: approved notes, and stale ones that were. */
const published = (status: KnowledgeStatus) => status === 'approved' || status === 'stale'

async function requireNote(id: string): Promise<KnowledgeNote> {
  const note = await knowledge.get(id)
  if (note === undefined) {
    throw new HttpError(404, 'No knowledge note has that id')
  }
  return note
}

async function auditDecision(kind: 'approved' | 'rejected', note: KnowledgeNote, extra: Record<string, unknown>) {
  await audit.record({
    actor: 'user',
    kind: kind === 'approved' ? 'context.knowledge_approved' : 'context.knowledge_rejected',
    subject_type: 'knowledge_note',
    subject_id: note.id,
    summary: `${kind === 'approved' ? 'Approved' : 'Rejected'} the ${note.kind} note "${note.title}"`,
    detail: {
      note_id: note.id,
      title: note.title,
      kind: note.kind,
      repo: note.repo_slug,
      ...(extra as Record<string, string | number | boolean | null>),
    },
  })
}

/** Sets a note's fields, keeping a revision when agents already saw it. */
async function saveFields(note: KnowledgeNote, fields: KnowledgeFields, source: ChangeSource) {
  await checkFields(fields)
  const changed = changedKeys(noteState(note), noteState(fields))
  if (changed.length === 0) {
    return { note, changed, revision: null }
  }
  const saved = await knowledge.setFields(note.id, fields)
  const revision = published(note.status)
    ? await recordRevision(source, ref(note.id), noteState(note), noteState(saved))
    : null
  return { note: saved, changed, revision }
}

/**
 * The user's edit of a note in any state but rejected. Edits to a published note keep a
 * revision, so the history shows what agents were told before.
 */
export async function editKnowledge(
  id: string,
  fields: KnowledgeFields,
  source: ChangeSource = byUser(),
): Promise<{ note: KnowledgeNote; revision: number | null }> {
  refuseDelegateReview()
  const note = await requireNote(id)
  if (note.status === 'rejected') {
    throw new HttpError(409, 'A rejected note cannot be edited')
  }
  const saved = await saveFields(note, fields, source)
  if (saved.changed.length > 0) {
    await audit.record({
      actor: 'user',
      kind: 'context.knowledge_edited',
      subject_type: 'knowledge_note',
      subject_id: id,
      summary: `Edited the ${saved.note.kind} note "${saved.note.title}"`,
      detail: { note_id: id, title: saved.note.title, changed: saved.changed, ...sourceDetail(source, saved.revision) },
    })
  }
  return { note: saved.note, revision: saved.revision }
}

/**
 * Approves a proposal, or a stale note again, after the user's edits if any. A correction's
 * approval retires the note it corrects.
 */
export async function approveKnowledge(id: string, input: ApproveKnowledge): Promise<KnowledgeNote> {
  refuseDelegateReview()
  const before = await requireNote(id)
  if (before.status !== 'proposed' && before.status !== 'stale') {
    throw new HttpError(409, `This note is ${before.status}; only a proposal or a stale note can be approved`)
  }
  const edited = input.edit === undefined ? null : await saveFields(before, input.edit, byUser())
  const approved = await knowledge.decide(id, [before.status], 'approved', null)
  if (approved === undefined) {
    throw new HttpError(409, 'This note changed while you looked; open it again')
  }
  const revision =
    before.status === 'proposed' ? await recordRevision(byUser('Approved'), ref(id), null, noteState(approved)) : null
  await auditDecision('approved', approved, {
    edited: (edited?.changed.length ?? 0) > 0,
    again: before.status === 'stale',
    revision: revision ?? edited?.revision ?? null,
  })
  if (approved.corrects_id !== null) {
    const retired = await knowledge.decide(
      approved.corrects_id,
      ['approved', 'stale'],
      'rejected',
      'Replaced by its correction',
    )
    if (retired !== undefined) {
      await auditDecision('rejected', retired, { replaced_by: id })
    }
  }
  return approved
}

/** Rejects a proposal, or retires a published note so it reaches no agent any more. */
export async function rejectKnowledge(id: string, reason: string | undefined): Promise<KnowledgeNote> {
  refuseDelegateReview()
  const before = await requireNote(id)
  const rejected = await knowledge.decide(id, ['proposed', 'approved', 'stale'], 'rejected', reason ?? null)
  if (rejected === undefined) {
    throw new HttpError(409, `This note is already ${before.status}`)
  }
  await auditDecision('rejected', rejected, { was: before.status, reason: reason ?? null })
  return rejected
}

/** Puts the fields a revision changed back to their values before it, as a new revision. */
export async function restoreKnowledge(
  id: string,
  before: RevisionState,
  keys: readonly string[],
  source: ChangeSource,
): Promise<number | null> {
  const state: RevisionState = { ...noteState(await requireNote(id)) }
  for (const key of keys.filter((name) => name in before)) {
    state[key] = before[key] ?? null
  }
  const lines = Array.isArray(state.sources) ? state.sources : []
  const sources = lines.map((line) => ({
    kind: line.slice(0, line.indexOf(': ')),
    ref: line.slice(line.indexOf(': ') + 2),
  }))
  const parsed = knowledgeFields.safeParse({ ...state, sources })
  if (!parsed.success) {
    throw new HttpError(409, `This revision no longer applies: ${describeIssues(parsed.error)}`)
  }
  return (await editKnowledge(id, parsed.data, source)).revision
}
