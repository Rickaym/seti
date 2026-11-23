import type { RewindFilesResult } from '@anthropic-ai/claude-agent-sdk'
import type { RewindFilesPreview, RewindRestore, RewindResult, RewindTarget, Task } from '@seti/shared'
import { audit } from './audit.js'
import { refuseOnSelf } from './ea-guard.js'
import { HttpError } from './http.js'
import { taskLauncher } from './launch-plan.js'
import { matchChain, rewindPoints, type ChainMatch, type RewindPoint } from './rewind.js'
import { closeIdleSession, isRunning } from './runner.js'
import { rewindFiles, sessionChain } from './runtimes/claude/rewind-files.js'
import { adapterFor, DEFAULT_RUNTIME } from './runtimes/registry.js'
import { shellTurnGuard } from './shell-context.js'
import { rewinds } from './store/rewinds.js'
import { requireTask } from './tasks.js'

const PREVIEW_CHARS = 200

const pointsOf = async (task: Task) =>
  rewindPoints(await rewinds.rows(task.id), await rewinds.list(task.id), task.session_id)

/** Earlier prompts the task can go back to, newest first. */
export async function rewindTargets(taskId: string): Promise<RewindTarget[]> {
  return (await pointsOf(await requireTask(taskId)))
    .reverse()
    .map(({ message_id, text, created_at, message_count }) => ({ message_id, text, created_at, message_count }))
}

function assertIdle(taskId: string): void {
  if (isRunning(taskId)) {
    throw new HttpError(409, 'Stop the agent before rewinding')
  }
  const shell = shellTurnGuard(taskId)
  if (shell !== null) {
    throw new HttpError(409, shell)
  }
}

async function requirePoint(task: Task, messageId: number): Promise<RewindPoint> {
  const point = (await pointsOf(task)).find((p) => p.message_id === messageId)
  if (!point) {
    throw new HttpError(409, 'That message is not a prompt this agent can rewind to')
  }
  return point
}

async function locate(task: Task, point: RewindPoint): Promise<ChainMatch> {
  const match = matchChain(await sessionChain(task.session_id), point)
  if (!match.keep_found) {
    throw new HttpError(409, 'That prompt is no longer in the session history Claude Code keeps')
  }
  return match
}

/** Lists, and unless dryRun puts back, the task's files as they were at a prompt. */
async function filesAt(task: Task, promptUuid: string, dryRun: boolean): Promise<RewindFilesResult> {
  if (task.session_id === null) {
    return { canRewind: false, error: 'This agent has no session yet' }
  }
  const launcher = await taskLauncher(task, 'agent', false)
  return rewindFiles({ cwd: task.cwd, id: task.session_id, launcher }, promptUuid, dryRun)
}

const NO_CHECKPOINT = 'Claude Code has no file checkpoint for this prompt'
const NO_FILE_REWIND = "This agent's runtime cannot put files back"

const canRewind = () => adapterFor(DEFAULT_RUNTIME).capabilities.rewind

/** Refuses a rewind of a part the agent's runtime cannot put back. */
function refuseUnsupported(restore: RewindRestore): void {
  const { conversation, code } = canRewind()
  if (restore !== 'code' && !conversation) {
    throw new HttpError(409, "This agent's runtime cannot resume from an earlier prompt")
  }
  if (restore !== 'conversation' && !code) {
    throw new HttpError(409, NO_FILE_REWIND)
  }
}

async function plannedFiles(task: Task, match: ChainMatch): Promise<RewindFilesResult> {
  if (!canRewind().code) {
    return { canRewind: false, error: NO_FILE_REWIND }
  }
  return match.prompt_uuid === null
    ? { canRewind: false, error: NO_CHECKPOINT }
    : filesAt(task, match.prompt_uuid, true)
}

/** What restoring code to just before a prompt would change; nothing is written. */
export async function previewRewindFiles(taskId: string, messageId: number): Promise<RewindFilesPreview> {
  const task = await requireTask(taskId)
  const match = await locate(task, await requirePoint(task, messageId))
  const result = await plannedFiles(task, match)
  return {
    can_rewind: result.canRewind,
    error: result.canRewind ? null : (result.error ?? NO_CHECKPOINT),
    files: result.filesChanged ?? [],
    insertions: result.insertions ?? 0,
    deletions: result.deletions ?? 0,
  }
}

async function restoreFiles(task: Task, match: ChainMatch): Promise<string[]> {
  if (match.prompt_uuid === null) {
    throw new HttpError(409, NO_CHECKPOINT)
  }
  const result = await filesAt(task, match.prompt_uuid, false)
  if (!result.canRewind) {
    throw new HttpError(409, result.error ?? NO_CHECKPOINT)
  }
  return result.filesChanged ?? []
}

const preview = (text: string) => (text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}...` : text)

/** Goes back to just before an earlier prompt: its conversation on the next turn, its files now. */
export async function rewindTask(taskId: string, messageId: number, restore: RewindRestore): Promise<RewindResult> {
  refuseOnSelf(taskId, 'rewind')
  refuseUnsupported(restore)
  const task = await requireTask(taskId)
  assertIdle(task.id)
  const point = await requirePoint(task, messageId)
  const match = await locate(task, point)
  if (!(await closeIdleSession(task.id))) {
    throw new HttpError(409, 'Background work is still running; wait for it or stop it before rewinding')
  }
  const files = restore === 'conversation' ? [] : await restoreFiles(task, match)
  const conversation = restore !== 'code'
  const rewind = await rewinds.insert({
    task_id: task.id,
    prompt_message_id: point.message_id,
    last_message_id: point.last_message_id,
    message_count: conversation ? point.message_count : 0,
    prompt_text: point.text,
    restore,
    state: conversation ? 'pending' : 'applied',
    resume_at: conversation ? point.keep : null,
    drops_turn: conversation ? match.drops_turn : null,
    files_changed: files,
  })
  await audit.record({
    actor: 'user',
    kind: 'task.rewound',
    subject_type: 'task',
    subject_id: task.id,
    summary: `Rewound task "${task.title}" to before "${preview(point.text.split('\n')[0] ?? '')}"`,
    detail: {
      title: task.title,
      prompt: preview(point.text),
      restore,
      messages_rewound: rewind.message_count,
      files_restored: files,
    },
  })
  return { task: await requireTask(task.id), rewind, prompt: point.text }
}
