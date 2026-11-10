import { describeChange, type ChangeRequest, type PermissionRequest, type Question } from '@seti/shared'
import { inBackground } from './background.js'
import { tasks } from './db.js'
import { changeRequests } from './store/change-requests.js'
import { permissionRequests } from './store/permissions.js'
import { questions } from './store/questions.js'
import { onAnyTaskEvent, publish } from './task-events.js'

const LINE_CHARS = 120

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 3)}...` : text)

/** Why an agent waits on the user besides a permission request; the order is their priority. */
const STALL_SOURCES = ['mcp', 'silent'] as const
export type StallSource = (typeof STALL_SOURCES)[number]

/** Each task's stalls by source, held in memory: a restart ends the sessions they come from. */
const stalls = new Map<string, Map<StallSource, string>>()

/** The reason line of the oldest pending request, with how many more wait behind it. */
function permissionLine(pending: readonly PermissionRequest[]): string | null {
  const [first] = pending
  if (first === undefined) {
    return null
  }
  const what = first.tool_name === 'ExitPlanMode' ? 'Asks to approve its plan' : `Asks to use ${first.tool_name}`
  const asked = first.summary === '' || first.tool_name === 'ExitPlanMode' ? what : `${what}: ${first.summary}`
  const line = first.kind === 'repeat' ? (first.reason ?? asked) : asked
  const more = pending.length > 1 ? ` (+${String(pending.length - 1)} more)` : ''
  return `${clip(line, LINE_CHARS)}${more}`
}

/** The reason line of the agent's open questions, with the first one's text. */
function questionLine(open: readonly Question[]): string | null {
  const [first] = open
  if (first === undefined) {
    return null
  }
  const count = open.length === 1 ? 'Asks a question' : `Asks ${String(open.length)} questions`
  return clip(`${count}: ${first.prompt.replace(/\s+/g, ' ')}`, LINE_CHARS)
}

/** The reason line of the oldest change the agent asked for, with how many more wait. */
function changeLine(pending: readonly ChangeRequest[]): string | null {
  const [first] = pending
  if (first === undefined) {
    return null
  }
  const line = clip(`Asks for ${describeChange(first.change)}`, LINE_CHARS)
  const more = pending.length > 1 ? ` (+${String(pending.length - 1)} more)` : ''
  return `${line}${more}`
}

function stallLine(taskId: string): string | null {
  const own = stalls.get(taskId)
  const source = STALL_SOURCES.find((name) => own?.has(name) === true)
  return source === undefined ? null : (own?.get(source) ?? null)
}

/** Each task's refreshes in order, so an older reason line never lands after a newer one. */
const refreshing = new Map<string, Promise<string | null>>()

async function refresh(taskId: string): Promise<string | null> {
  const blocked =
    permissionLine(await permissionRequests.pending(taskId)) ??
    questionLine(await questions.openList(taskId)) ??
    changeLine(await changeRequests.pending(taskId)) ??
    stallLine(taskId)
  if (await tasks.setBlocked(taskId, blocked)) {
    publish(taskId, { type: 'blocked', blocked })
  }
  return blocked
}

/**
 * Sets the task's reason line from what it waits on: a permission request first, then its open
 * questions, then a change the agent asked for, else a stall.
 * A change tells the task's views, and a new reason pushes a needs-you notification.
 */
export async function refreshBlocked(taskId: string): Promise<string | null> {
  const next = (refreshing.get(taskId) ?? Promise.resolve(null)).catch(() => null).then(async () => refresh(taskId))
  refreshing.set(taskId, next)
  try {
    return await next
  } finally {
    if (refreshing.get(taskId) === next) {
      refreshing.delete(taskId)
    }
  }
}

/** Records why the task waits on the user, or that it no longer does for that source. */
export async function setStall(taskId: string, source: StallSource, reason: string | null): Promise<void> {
  const own = stalls.get(taskId) ?? new Map<StallSource, string>()
  if ((own.get(source) ?? null) === reason) {
    return
  }
  if (reason === null) {
    own.delete(source)
  } else {
    own.set(source, clip(reason, LINE_CHARS))
  }
  if (own.size === 0) {
    stalls.delete(taskId)
  } else {
    stalls.set(taskId, own)
  }
  await refreshBlocked(taskId)
}

/** The tasks with a stall from the source, such as for the watchdog to clear. */
export const stalledBy = (source: StallSource): string[] =>
  [...stalls].filter(([, own]) => own.has(source)).map(([taskId]) => taskId)

/** Clears the source's stall on every task, as a sign-in does for MCP servers. */
export async function clearStalls(source: StallSource): Promise<void> {
  for (const taskId of stalledBy(source)) {
    await setStall(taskId, source, null)
  }
}

/** A new turn tries again what an MCP sign-in held up, so its stall goes until it asks again. */
export function clearStallsOnTurnStart(): void {
  onAnyTaskEvent((taskId, event) => {
    if (event.type === 'status' && event.status === 'running' && stalls.get(taskId)?.has('mcp') === true) {
      inBackground('stalls', async () => setStall(taskId, 'mcp', null))
    }
  })
}
