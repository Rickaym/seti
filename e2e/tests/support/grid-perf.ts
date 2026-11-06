import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { openSeedDb } from './db.js'
import { paths } from './env.js'

export const GRID_AGENTS = 9

const COLOURS = ['#e8605b', '#e77f3e', '#4eb068', '#3baca6', '#5488ec', '#7e74e1', '#b066da', '#cb57be', null]
const LINKED_PRS = 3
const SESSION = 'grid-perf-session'

const assistant = (content: unknown[], parent: string | null = null) => ({
  type: 'assistant',
  message: { id: randomUUID(), type: 'message', role: 'assistant', model: 'claude', content },
  parent_tool_use_id: parent,
  session_id: SESSION,
  uuid: randomUUID(),
})

const result = (id: string, content: string, parent: string | null = null) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] },
  parent_tool_use_id: parent,
  session_id: SESSION,
  uuid: randomUUID(),
})

const system = (payload: object) => ({ type: 'system', session_id: SESSION, uuid: randomUUID(), ...payload })

const prose = (step: number) =>
  `## Step ${String(step)}\n\nChecked the **deploy** and the \`voice-agent\` rollout:\n\n` +
  `- The tag moved to v${String(40 + step)}.\n- Two pods restarted once.\n\n` +
  '```ts\nexport const retry = (times = 3) => times > 0\n```\n'

/** A long transcript: prose, bursts of tool calls that fold into groups, and a subagent. */
function transcript(agent: number): [string, unknown][] {
  const rows: [string, unknown][] = [['prompt', { text: `Agent ${String(agent)}: ship the fix and watch it.` }]]
  for (let step = 0; step < 10; step++) {
    rows.push(['sdk', assistant([{ type: 'text', text: prose(step) }])])
    for (let call = 0; call < 5; call++) {
      const id = `toolu_${String(agent)}_${String(step)}_${String(call)}`
      const input = { command: `kubectl get pods -n app-${String(call)}`, description: `Check pods ${String(call)}` }
      rows.push(['sdk', assistant([{ type: 'tool_use', id, name: 'Bash', input }])])
      rows.push(['sdk', result(id, `pod-${String(call)} Running`)])
    }
    if (step % 4 === 1) {
      const id = `toolu_${String(agent)}_agent_${String(step)}`
      const task = `a_${String(agent)}_${String(step)}`
      const description = `Review service ${String(step)}`
      const input = { description, subagent_type: 'general-purpose', prompt: 'Review it.', run_in_background: true }
      rows.push(['sdk', assistant([{ type: 'tool_use', id, name: 'Agent', input }])])
      rows.push([
        'sdk',
        system({
          subtype: 'task_started',
          task_id: task,
          tool_use_id: id,
          description,
          subagent_type: 'general-purpose',
          is_backgrounded: true,
          spawn_depth: 1,
          task_type: 'local_agent',
        }),
      ])
      rows.push(['sdk', result(id, `Async agent launched successfully.\nagentId: ${task} (internal ID)`)])
      rows.push([
        'sdk',
        system({
          subtype: 'task_notification',
          task_id: task,
          tool_use_id: id,
          status: 'completed',
          output_file: '',
          summary: 'All good.',
          usage: { total_tokens: 1000, tool_uses: 3, duration_ms: 9000 },
        }),
      ])
    }
  }
  rows.push(['sdk', assistant([{ type: 'text', text: 'All done; the rollout settled.' }])])
  return rows
}

const gridPerfPrUrl = (agent: number, n: number) => `https://github.com/e2e/grid${String(agent)}/pull/${String(n)}`

/** Idle agents with long transcripts, colours and linked PRs, oldest first. */
export async function seedGridAgents(): Promise<string[]> {
  const db = openSeedDb()
  const ids: string[] = []
  const start = Date.now() - 3_600_000
  for (let agent = 0; agent < GRID_AGENTS; agent++) {
    const id = randomUUID()
    const at = new Date(start + agent * 1000).toISOString()
    await db.idleTask(id, `Grid perf ${String(agent + 1)}`, paths.checkout, at)
    await db.run('UPDATE task SET color = ? WHERE id = ?', COLOURS[agent] ?? null, id)
    await db.run('BEGIN')
    let t = start
    for (const [kind, payload] of transcript(agent)) {
      t += 1000
      await db.message(id, kind, JSON.stringify(payload), new Date(t).toISOString())
    }
    await db.run('COMMIT')
    for (let n = 1; n <= LINKED_PRS; n++) {
      await db.run(
        `INSERT INTO task_pr (task_id, pr_url, linked_at, source) VALUES (?, ?, ?, 'user')`,
        id,
        gridPerfPrUrl(agent, n),
        new Date(start + n * 1000).toISOString(),
      )
      await db.run(
        `INSERT INTO pr_watch (pr_url, snapshot, open, checked_at) VALUES (?, ?, 1, ?)`,
        gridPerfPrUrl(agent, n),
        JSON.stringify({ state: 'open', conflicting: false, ci: null, review_ids: [], comment_ids: [] }),
        new Date().toISOString(),
      )
    }
    ids.push(id)
  }
  await db.close()
  return ids
}

export const LARGE_ROW_AGENTS = 3
const LARGE_ROW_STEPS = 40
const LARGE_OUTPUT = 'pod/voice-agent-7f9c Running 0 12d\n'.repeat(30_000)

/** Shell calls that `cd` into a long path before a redirect or `||`, without a description. */
const cdCommand = (dir: string, step: number) =>
  step % 2 === 0 ? `cd ${dir} 2>/dev/null && git status --short` : `cd ${dir} || exit 1\nls -la`

/** Agents like long-running leads: megabyte tool results among shell calls that start with `cd`. */
export async function seedLargeRowAgents(): Promise<string[]> {
  const db = openSeedDb()
  const ids: string[] = []
  const start = Date.now() - 3_600_000
  for (let agent = 0; agent < LARGE_ROW_AGENTS; agent++) {
    const id = randomUUID()
    const dir = `/home/user/.seti/worktrees/dashboard-${id}`
    await db.idleTask(id, `Large rows ${String(agent + 1)}`, paths.checkout, new Date(start).toISOString())
    const rows: [string, unknown][] = [['prompt', { text: 'Watch the rollout and report back.' }]]
    for (let step = 0; step < LARGE_ROW_STEPS; step++) {
      const call = `toolu_large_${String(agent)}_${String(step)}`
      rows.push([
        'sdk',
        assistant([{ type: 'tool_use', id: call, name: 'Bash', input: { command: cdCommand(dir, step) } }]),
      ])
      rows.push(['sdk', result(call, step % 10 === 0 ? LARGE_OUTPUT : 'nothing to commit')])
    }
    rows.push(['sdk', assistant([{ type: 'text', text: `Large rows ${String(agent + 1)} settled.` }])])
    await db.run('BEGIN')
    for (const [index, [kind, payload]] of rows.entries()) {
      await db.message(id, kind, JSON.stringify(payload), new Date(start + index * 1000).toISOString())
    }
    await db.run('COMMIT')
    ids.push(id)
  }
  await db.close()
  return ids
}

/** The stored grid: the agents three by three, the first focused. */
export function gridStorage(ids: readonly string[]): string {
  const panels = ids.map((agent, index) => ({
    i: `p${String(index + 1)}`,
    agent,
    x: (index % 3) * 4,
    y: Math.floor(index / 3) * 8,
    w: 4,
    h: 8,
  }))
  return JSON.stringify({ v: 2, enabled: true, panels, locked: false, focused: 'p1', recent: [] })
}

interface Probe {
  longTasks: { start: number; duration: number }[]
  counting: boolean
  commits: number
  /** Components rendered inside each grid panel, by panel id. */
  renders: Record<string, number>
}

/** Records long tasks, and through the React DevTools hook the components rendered per panel. */
export function installProbe(): void {
  const probe: Probe = { longTasks: [], counting: false, commits: 0, renders: {} }
  Reflect.set(window, '__gridPerf', probe)
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      probe.longTasks.push({ start: entry.startTime, duration: entry.duration })
    }
  }).observe({ type: 'longtask', buffered: true })
  interface Fiber {
    tag: number
    flags: number
    child: Fiber | null
    sibling: Fiber | null
    alternate: Fiber | null
    memoizedProps: unknown
  }
  const COMPONENT_TAGS = new Set([0, 1, 11, 14, 15])
  const HOST_TAG = 5
  const PERFORMED_WORK = 1
  const panelOf = (fiber: Fiber, outer: string | null) => {
    if (fiber.tag !== HOST_TAG || typeof fiber.memoizedProps !== 'object' || fiber.memoizedProps === null) {
      return outer
    }
    const id: unknown = Reflect.get(fiber.memoizedProps, 'data-grid-panel')
    return typeof id === 'string' ? id : outer
  }
  const visit = (next: Fiber, prev: Fiber | null, outer: string | null) => {
    const panel = panelOf(next, outer)
    const rendered = prev === null || (next.flags & PERFORMED_WORK) === PERFORMED_WORK
    if (panel !== null && rendered && COMPONENT_TAGS.has(next.tag)) {
      probe.renders[panel] = (probe.renders[panel] ?? 0) + 1
    }
    if (prev !== null && next.child === prev.child) {
      return
    }
    for (let child = next.child; child !== null; child = child.sibling) {
      visit(child, prev === null ? null : child.alternate, panel)
    }
  }
  let renderers = 0
  Reflect.set(window, '__REACT_DEVTOOLS_GLOBAL_HOOK__', {
    supportsFiber: true,
    renderers: new Map(),
    inject: () => ++renderers,
    checkDCE: () => undefined,
    onScheduleFiberRoot: () => undefined,
    onCommitFiberUnmount: () => undefined,
    onPostCommitFiberRoot: () => undefined,
    onCommitFiberRoot: (_id: number, root: { current: Fiber }) => {
      if (probe.counting) {
        probe.commits += 1
        visit(root.current, root.current.alternate, null)
      }
    },
  })
}

export interface ProbeReading {
  /** Components rendered per panel since counting started. */
  renders: Record<string, number>
  longTasks: { count: number; worstMs: number; totalMs: number }
}

/** Starts counting renders afresh; returns the page time to read long tasks from. */
export async function startCounting(page: Page): Promise<number> {
  return page.evaluate(() => {
    const probe = Reflect.get(window, '__gridPerf') as Probe
    probe.counting = true
    probe.commits = 0
    probe.renders = {}
    return performance.now()
  })
}

export async function readProbe(page: Page, since: number): Promise<ProbeReading> {
  return page.evaluate((from) => {
    const probe = Reflect.get(window, '__gridPerf') as Probe
    const tasks = probe.longTasks.filter((task) => task.start >= from).map((task) => task.duration)
    return {
      renders: { ...probe.renders },
      longTasks: {
        count: tasks.length,
        worstMs: Math.round(Math.max(0, ...tasks)),
        totalMs: Math.round(tasks.reduce((sum, ms) => sum + ms, 0)),
      },
    }
  }, since)
}
