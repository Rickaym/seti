import type { EaContext, MessageRow, Task, TaskEvent } from '@seti/shared'
import { tasks } from './db.js'
import { hideDirect } from './direct-privacy.js'
import { renderContext } from './ea-context-render.js'
import { LISTED_MAX, LISTED_MIN_PRIORITY, taskViews, type ContextInput, type OpenPrView } from './ea-context-tasks.js'
import { viewerLogin } from './github.js'
import { cachedOpenPrs, onOpenPrsFetched } from './prs.js'
import { cache } from './redis.js'
import { openQuerySince, sessionState } from './runner.js'
import { channelSubscriptions } from './store/channel-subscriptions.js'
import { rolePacksByTask } from './store/context.js'
import { eaContextStore } from './store/ea-context.js'
import { prWatch } from './store/pr-watch.js'
import { teamMessages } from './store/team.js'
import { agentTodos, subtaskBriefs } from './subtask-cache.js'
import { onAnyTaskEvent } from './task-events.js'
import { subscribeTeam } from './team-events.js'

const ACTIVITY_ROWS = 8
const NOTABLE_ROWS = 40
const PR_WAIT_MS = 1500
const TEAM_ROWS = 20

export async function withinMs<T>(ms: number, work: Promise<T>): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      resolve(null)
    }, ms)
  })
  try {
    return await Promise.race([work, late])
  } finally {
    clearTimeout(timer)
  }
}

/** Open PRs from the shared cache; a list GitHub has not sent yet arrives with a later build. */
async function openPrs(): Promise<{ prs: OpenPrView[]; viewer: string | null } | null> {
  const load = Promise.all([cachedOpenPrs(), viewerLogin().catch(() => null)]).then(([prs, viewer]) => ({
    prs,
    viewer,
  }))
  return withinMs(
    PR_WAIT_MS,
    load.catch(() => null),
  )
}

async function openSessions(list: readonly Task[]): Promise<ContextInput['sessions']> {
  const open = list.filter((task) => sessionState(task.id).open)
  const entries = await Promise.all(
    open.map(async (task) => {
      const subagents = await subtaskBriefs(task.id, openQuerySince(task.id))
      return [task.id, { background: sessionState(task.id).background, subagents }] as const
    }),
  )
  return new Map(entries)
}

const NOBODY = { kind: 'nobody' } as const

/** Rows of many tasks with every direct message hidden, since the EA and agents share this view. */
async function hideAllDirect(rows: readonly MessageRow[]): Promise<MessageRow[]> {
  const shown = new Map<number, MessageRow>()
  for (const taskId of new Set(rows.map((row) => row.task_id))) {
    for (const row of await hideDirect(
      taskId,
      rows.filter((found) => found.task_id === taskId),
      NOBODY,
    )) {
      shown.set(row.id, row)
    }
  }
  return rows.map((row) => shown.get(row.id) ?? row)
}

/** Reads everything the context needs; only the tasks it will list get their recent messages read. */
async function gatherContext(now = Date.now()): Promise<ContextInput> {
  const [list, prStates, waiting, notable, eaChannels, prData, team, rolePacks] = await Promise.all([
    tasks.list(),
    prWatch.allTaskStates(),
    eaContextStore.waitingUpdates(),
    eaContextStore.notable(NOTABLE_ROWS),
    channelSubscriptions.eaChannelIds(),
    openPrs(),
    teamMessages.list({ kind: 'public' }, TEAM_ROWS),
    rolePacksByTask(),
  ])
  const sessions = await openSessions(list)
  const listed = taskViews({ now, tasks: list, prStates, sessions, waiting })
    .filter((view) => view.priority >= LISTED_MIN_PRIORITY)
    .slice(0, LISTED_MAX)
  const ids = listed.map((view) => view.task.id)
  const [recent, todos] = await Promise.all([
    eaContextStore.recentActivity(ids, ACTIVITY_ROWS),
    Promise.all(ids.map(async (id) => [id, await agentTodos(id)] as const)),
  ])
  const activity = new Map<string, MessageRow[]>()
  for (const [taskId, rows] of recent) {
    activity.set(taskId, await hideDirect(taskId, rows, NOBODY))
  }
  const prs = prData?.prs ?? null
  const viewer = prData?.viewer ?? null
  const roles = new Map([...rolePacks].map(([taskId, pack]) => [taskId, pack.name]))
  return {
    now,
    tasks: list,
    prStates,
    sessions,
    waiting,
    activity,
    todos: new Map(todos.filter(([, items]) => items.length > 0)),
    prs,
    viewer,
    notable: await hideAllDirect(notable),
    eaChannels,
    team,
    roles,
  }
}

/** Streamed agent text may leave the context this far behind; status changes never do. */
const SOFT_STALE_MS = 5_000
/** Rebuilt at least this often, for PR lists and relative times. */
const MAX_AGE_MS = 30_000
const CACHE_KEY = 'ea:context'
const CACHE_TTL_S = 60

interface Built {
  context: EaContext
  built_at: number
}

type Memo = Built & { hard: number; soft: number }

let memo: Memo | null = null
let hardChanges = 0
let softChanges = 0
let building: Promise<EaContext> | null = null

/** Marks the context out of date; a hard change is one the EA must never miss, such as a status. */
export function invalidateContext(hard: boolean): void {
  softChanges += 1
  if (hard) {
    hardChanges += 1
    void cache.del(CACHE_KEY)
  }
}

/** Status, PR and subagent changes and messages that end turns or bring updates are hard changes. */
export function isHardChange(event: TaskEvent): boolean {
  if (event.type !== 'message') {
    return event.type !== 'updated' && event.type !== 'shell'
  }
  const { row } = event
  return row.kind !== 'sdk' || row.payload.type === 'result'
}

const isFresh = (built: Memo, now: number) =>
  built.hard === hardChanges &&
  now - built.built_at < MAX_AGE_MS &&
  (built.soft === softChanges || now - built.built_at < SOFT_STALE_MS)

async function build(): Promise<EaContext> {
  const hard = hardChanges
  const soft = softChanges
  const now = Date.now()
  const context = { ...renderContext(await gatherContext(now)), as_of: new Date(now).toISOString() }
  memo = { context, built_at: now, hard, soft }
  if (hard === hardChanges) {
    await cache.set(CACHE_KEY, { context, built_at: now } satisfies Built, CACHE_TTL_S)
  }
  return context
}

/** The live context, from memory or Redis while fresh, else rebuilt once for every waiting caller. */
export async function liveContext(): Promise<EaContext> {
  const now = Date.now()
  if (memo !== null && isFresh(memo, now)) {
    return memo.context
  }
  if (memo === null || memo.hard === hardChanges) {
    const shared = await cache.get<Built>(CACHE_KEY)
    if (shared !== undefined && now - shared.built_at < SOFT_STALE_MS) {
      memo = { ...shared, hard: hardChanges, soft: softChanges }
      return shared.context
    }
  }
  building ??= build().finally(() => {
    building = null
  })
  return building
}

/** Keeps the context in step with task and group chat events from every process and fresh PRs. */
export function followLiveContext(): void {
  onAnyTaskEvent((_taskId, event) => {
    invalidateContext(isHardChange(event))
  })
  onOpenPrsFetched(() => {
    invalidateContext(true)
  })
  subscribeTeam((event) => {
    invalidateContext(event.type === 'message')
  })
}
