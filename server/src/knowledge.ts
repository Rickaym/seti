import { randomUUID } from 'node:crypto'
import {
  KNOWLEDGE_BODY_MAX,
  KNOWLEDGE_FAILURES_TO_STALE,
  KNOWLEDGE_TITLE_MAX,
  type KnowledgeFields,
  type KnowledgeNote,
  type Task,
  type VerifyKnowledgeInput,
} from '@seti/shared'
import { audit } from './audit.js'
import { inBackground } from './background.js'
import { repos } from './db.js'
import { fromEa } from './ea-guard.js'
import { HttpError } from './http.js'
import { noteTexts, refusePrivateSources, refuseSecrets } from './knowledge-checks.js'
import { workingDirs } from './session-options.js'
import { knowledge } from './store/knowledge.js'

/** Proposals one agent may have waiting for the user at once. */
const KNOWLEDGE_WAITING_MAX = 10
const SEARCH_LIMIT = 8
const SWEEP_MS = 60 * 60_000

/** Who files a proposal: an agent through its seti tool, or the EA or the user through the API. */
export type Proposer = { kind: 'agent'; task: Task } | { kind: 'ea' } | { kind: 'user' }

/** The proposer of a request to the knowledge routes. */
export const requestProposer = (): Proposer => (fromEa() ? { kind: 'ea' } : { kind: 'user' })

/** The repos an agent's notes come from: global notes and those of its own repos. */
export const repoScope = (task: Pick<Task, 'repos'>) => task.repos.map((repo) => repo.id)

/** The folders a proposer may name in a source: an agent's own, or the repos for the EA. */
async function sourceRoots(proposer: Proposer): Promise<string[] | null> {
  switch (proposer.kind) {
    case 'agent':
      return [proposer.task.cwd, ...workingDirs(proposer.task)]
    case 'ea':
      return (await repos.list()).map((repo) => repo.path)
    case 'user':
      return null
  }
}

/** Refuses a note with a secret, and a repo scope that names no registered repo. */
export async function checkFields(fields: KnowledgeFields): Promise<void> {
  refuseSecrets(noteTexts(fields))
  if (fields.repo_id !== null && (await repos.get(fields.repo_id)) === undefined) {
    throw new HttpError(400, 'The repo scope names no registered repo; leave it out for a global note.')
  }
}

const noteDetail = (note: KnowledgeNote) => ({
  note_id: note.id,
  title: note.title,
  kind: note.kind,
  repo: note.repo_slug,
})

interface ProposeOptions {
  /** The approved note this one corrects. */
  correctsId?: string
  /** The sources came from an approved note, so they are not checked against this proposer. */
  trustedSources?: boolean
}

/**
 * Files a note for the user to approve; nothing reaches other agents before that. The seti tool,
 * the API and Seti's own corrections all come through here, and so should any later source of
 * proposals, such as lessons asked of an agent when its task ends.
 */
export async function proposeKnowledge(
  proposer: Proposer,
  fields: KnowledgeFields,
  options: ProposeOptions = {},
): Promise<KnowledgeNote> {
  await checkFields(fields)
  const roots = await sourceRoots(proposer)
  if (roots !== null && options.trustedSources !== true) {
    refusePrivateSources(fields.sources, roots)
  }
  const task = proposer.kind === 'agent' ? proposer.task : null
  if (
    task !== null &&
    options.correctsId === undefined &&
    (await knowledge.waitingFrom(task.id)) >= KNOWLEDGE_WAITING_MAX
  ) {
    throw new HttpError(
      429,
      `At most ${String(KNOWLEDGE_WAITING_MAX)} of your proposals wait at once; wait for answers.`,
    )
  }
  const note = await knowledge.insert({
    ...fields,
    id: randomUUID(),
    proposer: proposer.kind,
    proposer_task_id: task?.id ?? null,
    proposer_title: task?.title ?? null,
    corrects_id: options.correctsId ?? null,
  })
  await audit.record({
    actor: 'user',
    kind: 'context.knowledge_proposed',
    subject_type: 'knowledge_note',
    subject_id: note.id,
    summary: `Proposed the ${note.kind} note "${note.title}"`,
    detail: { ...noteDetail(note), proposer: note.proposer, corrects: note.corrects_id },
  })
  return note
}

/** One note by its id or the first 8 or more characters of it, as the index shows them. */
export async function findNote(ref: string, scope: readonly string[] | null): Promise<KnowledgeNote> {
  const id = ref.trim().toLowerCase()
  const found = /^[0-9a-f-]{8,36}$/.test(id) ? await knowledge.byPrefix(id, scope) : []
  const [note] = found
  if (note === undefined || found.length > 1) {
    throw new HttpError(404, `No approved knowledge note has the id ${ref}; search_knowledge lists them.`)
  }
  return note
}

/** Approved and stale notes in scope that match the words; null scope means every repo. */
export const searchKnowledge = async (query: string, scope: readonly string[] | null) =>
  knowledge.search(query, scope, SEARCH_LIMIT)

function correctionOf(note: KnowledgeNote, report: string): KnowledgeFields {
  const head = `Checks of this note failed ${String(KNOWLEDGE_FAILURES_TO_STALE)} times in a row. The latest report: ${report}`
  return {
    kind: note.kind,
    title: `Correction: ${note.title}`.slice(0, KNOWLEDGE_TITLE_MAX),
    body: `${head}\n\nThe note said:\n${note.body}`.slice(0, KNOWLEDGE_BODY_MAX),
    verify: note.verify,
    sources: note.sources,
    repo_id: note.repo_id,
  }
}

async function auditStale(note: KnowledgeNote, stale: boolean): Promise<void> {
  await audit.record({
    actor: stale ? 'system' : 'user',
    kind: 'context.knowledge_stale',
    subject_type: 'knowledge_note',
    subject_id: note.id,
    summary: stale
      ? `The note "${note.title}" went stale: ${note.status_reason ?? 'no reason given'}`
      : `The note "${note.title}" passed its check and is back in the index`,
    detail: { ...noteDetail(note), stale, reason: note.status_reason },
  })
}

/** Files the correction of a note that went stale on failed checks, once while one is open. */
async function fileCorrection(task: Task, note: KnowledgeNote, report: string): Promise<KnowledgeNote | null> {
  if ((await knowledge.openCorrection(note.id)) !== undefined) {
    return null
  }
  return proposeKnowledge({ kind: 'agent', task }, correctionOf(note, report), {
    correctsId: note.id,
    trustedSources: true,
  })
}

/** What one check came to, for the agent that ran it. */
export interface Verified {
  note: KnowledgeNote
  correction: KnowledgeNote | null
}

/**
 * Records an agent's check of a note's verify step. A pass keeps the note fresh and brings a
 * stale one back; the failure that makes it stale also files a correction for the user.
 */
export async function verifyKnowledge(task: Task, ref: string, input: VerifyKnowledgeInput): Promise<Verified> {
  refuseSecrets({ report: input.note })
  const target = await findNote(ref, repoScope(task))
  const outcome = await knowledge.check(target.id, input.passed)
  if (outcome === undefined) {
    throw new HttpError(409, 'That note is no longer approved, so there is nothing to check.')
  }
  const { note } = outcome
  await audit.record({
    actor: 'user',
    kind: 'context.knowledge_verified',
    subject_type: 'knowledge_note',
    subject_id: note.id,
    summary: `${input.passed ? 'Passed' : 'Failed'} the check of "${note.title}"`,
    detail: { ...noteDetail(note), passed: input.passed, report: input.note, failures: note.failures },
  })
  if (outcome.restored) {
    await auditStale(note, false)
  }
  if (!outcome.wentStale) {
    return { note, correction: null }
  }
  await auditStale(note, true)
  return { note, correction: await fileCorrection(task, note, input.note) }
}

/** Marks the notes not verified within their kind's time stale, auditing each as Seti's. */
export async function sweepStaleKnowledge(at = Date.now()): Promise<KnowledgeNote[]> {
  const stale = await knowledge.markStaleDue(at)
  for (const note of stale) {
    await auditStale(note, true)
  }
  return stale
}

/** Looks for notes past their time once an hour. */
export function startKnowledgeSweep(): void {
  setInterval(() => {
    inBackground('knowledge staleness', async () => {
      await sweepStaleKnowledge()
    })
  }, SWEEP_MS).unref()
}
