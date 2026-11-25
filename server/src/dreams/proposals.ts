import fs from 'node:fs'
import type { DreamDecision, DreamProposal, DreamProposalInput, DreamProposalKind, DreamRun, Task } from '@seti/shared'
import { audit } from '../audit.js'
import { tasks } from '../db.js'
import { refuseDelegates } from '../ea-guard.js'
import { HttpError } from '../http.js'
import { busyReason } from '../owned-dirs.js'
import { isRunning, sessionState } from '../session-mirror.js'
import { dreamProposals, PROPOSALS_PER_DREAM } from '../store/dream-proposals.js'
import { allowUnsubscribe } from './config-apply.js'
import { checkProposal } from './proposal-checks.js'
import { applyIntoTrash } from './trash.js'

/** A folder a process works in or git holds locked; a file is never one. */
const busyFolder = async (target: string) => (fs.statSync(target).isDirectory() ? busyReason(target) : null)

const liveAgents = async () => (await tasks.listAll()).filter((task) => task.archived_at === null)

/** Files a dream's clean-up proposal after checking it; the answer tells the dream what happened. */
export async function fileProposal(task: Task, run: DreamRun, input: DreamProposalInput): Promise<string> {
  if ((await dreamProposals.countForRun(run.id)) >= PROPOSALS_PER_DREAM) {
    return `Not filed: a dream proposes at most ${String(PROPOSALS_PER_DREAM)} clean-ups.`
  }
  const checked = await checkProposal(input, task, await liveAgents())
  if (typeof checked === 'string') {
    return `Not filed: ${checked}. Mention it in the report instead if it matters.`
  }
  const proposal = await dreamProposals.add(run, input, checked.bytes)
  await audit.record({
    actor: 'system',
    kind: 'dream.proposed',
    subject_type: 'task',
    subject_id: task.id,
    summary: `A dream of ${task.title} proposed: ${input.kind} ${input.target}`,
    detail: { run: run.id, proposal: proposal.id, kind: input.kind, target: input.target, bytes: checked.bytes },
  })
  return 'Filed. The user allows or denies it in the morning; nothing changes until then.'
}

/** Applies an unsubscribe a dream was unsure of, with an Undo like the ones it applied itself. */
async function allowConfig(proposal: DreamProposal, subject: string | null): Promise<DreamProposal> {
  const run = { id: proposal.run_id, task_id: proposal.task_id }
  const applied = await allowUnsubscribe(run, subject ?? '', proposal.reason)
  const failed = typeof applied === 'string' ? applied : null
  return (await dreamProposals.decide(proposal.id, failed === null ? 'allowed' : 'failed', failed)) ?? proposal
}

async function allow(proposal: DreamProposal & { subject: string | null }, task: Task) {
  const { kind, subject } = proposal
  return kind === 'unsubscribe' ? allowConfig(proposal, subject) : allowCleanup({ ...proposal, kind }, task)
}

async function allowCleanup(proposal: DreamProposal & { kind: DreamProposalKind }, task: Task) {
  if (isRunning(task.id) || sessionState(task.id).background > 0) {
    throw new HttpError(409, 'The agent is at work; allow this once its turn ends')
  }
  const checked = await checkProposal(proposal, task, await liveAgents())
  const busy = typeof checked === 'string' ? null : await busyFolder(checked.path)
  if (busy !== null) {
    throw new HttpError(409, `Not now: ${busy}`)
  }
  if (typeof checked === 'string') {
    return (await dreamProposals.decide(proposal.id, 'failed', checked)) ?? proposal
  }
  await applyIntoTrash(proposal, checked)
  return (await dreamProposals.decide(proposal.id, 'allowed', null)) ?? proposal
}

/**
 * Answers a dream's clean-up proposal. Allow is the user's own act: the EA, agents and mods are
 * refused. Allow checks the proposal again and moves the target into the trash, or marks it
 * failed with the reason when it is no longer safe.
 */
export async function decideProposal(id: number, { decision }: DreamDecision): Promise<DreamProposal> {
  refuseDelegates("answer a dream's clean-up")
  const proposal = await dreamProposals.get(id)
  if (proposal === undefined) {
    throw new HttpError(404, 'No such proposal')
  }
  if (proposal.state !== 'pending') {
    throw new HttpError(409, `It was ${proposal.state} already`)
  }
  const task = await tasks.get(proposal.task_id)
  if (task === undefined) {
    throw new HttpError(404, 'The agent is gone')
  }
  const decided =
    decision === 'deny' ? ((await dreamProposals.decide(id, 'denied', null)) ?? proposal) : await allow(proposal, task)
  await audit.record({
    actor: 'user',
    kind: 'dream.proposal_decided',
    subject_type: 'task',
    subject_id: task.id,
    summary: `${decision === 'allow' ? 'Allowed' : 'Denied'} a clean-up of ${task.title}: ${proposal.target}`,
    detail: { proposal: id, decision, state: decided.state },
  })
  return decided
}
