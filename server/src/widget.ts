import { listedStatus, waitsOnYou, WIDGET_LIMITS, type TaskListEntry, type WidgetSummary } from '@seti/shared'
import { withinMs } from './ea-context.js'
import { notifyBody } from './notifications.js'
import { cachedOpenPrs } from './prs.js'
import { costSince } from './store/cost.js'
import { workspaceRows } from './store/workspaces.js'
import { taskListEntries } from './task-actions.js'
import { currentToolCall } from './tool-calls.js'
import { agentRow, isReason, overviewOrder, waitingAgent, type OpenPrFacts, type RowContext } from './widget-rows.js'

/** The widget never waits long for GitHub; a PR list not cached yet shows on a later refresh. */
const PR_WAIT_MS = 1000

async function openPrFacts(): Promise<Map<string, OpenPrFacts>> {
  const prs =
    (await withinMs(
      PR_WAIT_MS,
      cachedOpenPrs().catch(() => null),
    )) ?? []
  return new Map(prs.map((pr) => [pr.url, { ci: pr.ci, unresolved_threads: pr.unresolved_threads }]))
}

async function workspaceNames(): Promise<Map<string, string> | null> {
  const list = await workspaceRows.list()
  return list.length > 1 ? new Map(list.map((workspace) => [workspace.id, workspace.name])) : null
}

export interface WidgetOptions {
  /** False replaces agent titles and other free text with generic labels. */
  showNames: boolean
  at?: Date
}

/** The reason lines of the waiting agents the summary lists, by task id. */
async function waitLines(waiting: readonly TaskListEntry[], showNames: boolean): Promise<Map<string, string>> {
  const lines = await Promise.all(
    waiting.map(async (entry) => [entry.id, showNames ? await notifyBody(entry, 'needs_you') : ''] as const),
  )
  return new Map(lines)
}

/** The home screen summary: who waits on the user and why, what each agent does, and counts. */
export async function widgetSummary({ showNames, at = new Date() }: WidgetOptions): Promise<WidgetSummary> {
  const midnight = new Date(at)
  midnight.setHours(0, 0, 0, 0)
  const [entries, cost, openPrs, workspaces] = await Promise.all([
    taskListEntries(),
    costSince(midnight.toISOString()),
    openPrFacts(),
    workspaceNames(),
  ])
  const waiting = entries
    .filter((entry) => waitsOnYou(entry, listedStatus(entry)))
    .sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at))
  const running = entries.filter((entry) => listedStatus(entry) === 'running').length
  const shown = overviewOrder(entries, at.getTime()).slice(0, WIDGET_LIMITS.agents)
  const listedWaiting = waiting.slice(0, WIDGET_LIMITS.waiting)
  const lineFor = new Set([...listedWaiting, ...shown.filter((entry) => waiting.includes(entry))])
  const lines = await waitLines([...lineFor], showNames)
  const waitingRow = (entry: TaskListEntry) => {
    const status = listedStatus(entry)
    return isReason(status) && waiting.includes(entry)
      ? waitingAgent(entry, status, lines.get(entry.id) ?? '', showNames)
      : null
  }
  const ctx: RowContext = {
    showNames,
    openPrs,
    workspaces,
    ownTool: (taskId) => currentToolCall(taskId, true)?.name ?? null,
  }
  return {
    needs_you: listedWaiting.flatMap((entry) => waitingRow(entry) ?? []),
    needs_you_count: waiting.length,
    agents: shown.map((entry) => agentRow(entry, ctx, waitingRow(entry)?.line ?? null)),
    running,
    idle: entries.length - running - waiting.length,
    cost_today_usd: Math.round(cost * 100) / 100,
    names_hidden: !showNames,
    updated_at: at.toISOString(),
    paths: { home: '/', agents: '/#agents' },
  }
}
