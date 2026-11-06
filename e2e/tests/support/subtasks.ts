import { randomUUID } from 'node:crypto'
import { openSeedDb } from './db.js'

const SESSION = 'seeded-fanout-session'
const START = Date.parse('2026-09-27T09:00:00.000Z')

type Row = [kind: string, payload: unknown]

const sdk = (payload: Record<string, unknown>): Row => ['sdk', { session_id: SESSION, uuid: randomUUID(), ...payload }]

const assistant = (content: unknown[], parent: string | null = null) =>
  sdk({
    type: 'assistant',
    parent_tool_use_id: parent,
    message: { id: randomUUID(), type: 'message', role: 'assistant', model: 'claude', content },
  })

const text = (value: string, parent: string | null = null) => assistant([{ type: 'text', text: value }], parent)

const tool = (id: string, name: string, input: Record<string, unknown>, parent: string | null = null) =>
  assistant([{ type: 'tool_use', id, name, input }], parent)

const result = (id: string, content: unknown, options: { parent?: string; error?: boolean; output?: unknown } = {}) =>
  sdk({
    type: 'user',
    parent_tool_use_id: options.parent ?? null,
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: id, content, ...(options.error === true ? { is_error: true } : {}) },
      ],
    },
    ...(options.output === undefined ? {} : { tool_use_result: options.output }),
  })

const agent = (id: string, description: string, background: boolean, parent: string | null = null) =>
  tool(
    id,
    'Agent',
    {
      description,
      subagent_type: 'general-purpose',
      prompt: `Seeded prompt: ${description}. Report what you find.`,
      run_in_background: background,
    },
    parent,
  )

interface Started {
  task: string
  id: string
  description: string
  background: boolean
  depth?: number
}

const started = ({ task, id, description, background, depth = 1 }: Started) =>
  sdk({
    type: 'system',
    subtype: 'task_started',
    task_id: task,
    tool_use_id: id,
    description,
    subagent_type: 'general-purpose',
    is_backgrounded: background,
    spawn_depth: depth,
    task_type: 'local_agent',
  })

const launched = (toolUseId: string, agentId: string, imported = false) =>
  result(
    toolUseId,
    [
      {
        type: 'text',
        text: `Async agent launched successfully.\nagentId: ${agentId} (internal ID)\nThe agent is working in the background.`,
      },
    ],
    imported ? {} : { output: { isAsync: true, status: 'async_launched', agentId, description: 'd', prompt: 'p' } },
  )

const progress = (taskId: string, toolUseId: string, lastTool: string, uses: number) =>
  sdk({
    type: 'system',
    subtype: 'task_progress',
    task_id: taskId,
    tool_use_id: toolUseId,
    description: 'progress',
    usage: { total_tokens: uses * 4100, tool_uses: uses, duration_ms: uses * 3000 },
    last_tool_name: lastTool,
  })

const notified = (taskId: string, toolUseId: string, status: string, summary: string) =>
  sdk({
    type: 'system',
    subtype: 'task_notification',
    task_id: taskId,
    tool_use_id: toolUseId,
    status,
    output_file: '',
    summary,
    usage: { total_tokens: 61_500, tool_uses: 14, duration_ms: 95_000 },
  })

const completed = (toolUseId: string, agentId: string, report: string, parent?: string) =>
  result(toolUseId, [{ type: 'text', text: report }], {
    ...(parent === undefined ? {} : { parent }),
    output: {
      status: 'completed',
      agentId,
      prompt: 'p',
      content: [{ type: 'text', text: report }],
      totalTokens: 23_800,
      totalToolUseCount: 5,
      totalDurationMs: 48_000,
    },
  })

export const FANOUT = {
  dashboard: { id: 'toolu_seed_dash', description: 'Check dashboard CI' },
  agent: { id: 'toolu_seed_agent', description: 'Review agent changes' },
  failed: { id: 'toolu_seed_fail', description: 'Audit on-prem manifests' },
  nested: { id: 'toolu_seed_nested', description: 'Read flaky test log' },
  subagentCommand: 'gh pr checks 42 -R globex/dashboard',
  nestedCommand: 'tail -n 200 logs/flaky.log',
  dashboardReport: '## Dashboard CI\n\nAll 14 checks pass on #42. The flaky test is a timing issue in the reaper.',
  agentReport: 'Agent changes look safe: two retries added, no API change.',
} as const

/** A finished task that fanned out to three subagents, one of which started its own. */
function fanOutRows(): Row[] {
  const { dashboard, agent: review, failed, nested } = FANOUT
  return [
    ['prompt', { text: 'Check the three services before the release.' }],
    text('I will check each service with its own subagent.'),
    agent(dashboard.id, dashboard.description, true),
    started({ task: 'a_dash', id: dashboard.id, description: dashboard.description, background: true }),
    launched(dashboard.id, 'a_dash'),
    agent(review.id, review.description, false),
    started({ task: 'a_review', id: review.id, description: review.description, background: false }),
    tool('toolu_seed_dash_1', 'Bash', { command: FANOUT.subagentCommand }, dashboard.id),
    result('toolu_seed_dash_1', 'All checks were successful\n14 successful checks', { parent: dashboard.id }),
    progress('a_dash', dashboard.id, 'Bash', 1),
    tool('toolu_seed_review_1', 'Read', { file_path: 'src/retry.py' }, review.id),
    result('toolu_seed_review_1', 'def retry(): ...', { parent: review.id }),
    agent(nested.id, nested.description, false, dashboard.id),
    started({ task: 'a_nested', id: nested.id, description: nested.description, background: false, depth: 2 }),
    tool('toolu_seed_nested_1', 'Bash', { command: FANOUT.nestedCommand }, nested.id),
    result('toolu_seed_nested_1', 'reaper timed out after 30s', { parent: nested.id }),
    completed(nested.id, 'a_nested', 'The flaky test times out in the reaper.', dashboard.id),
    progress('a_dash', dashboard.id, 'Agent', 3),
    completed(review.id, 'a_review', FANOUT.agentReport),
    agent(failed.id, failed.description, false),
    result(failed.id, 'Agent type "manifest-auditor" not found', { error: true }),
    notified('a_dash', dashboard.id, 'completed', FANOUT.dashboardReport),
    text('All three checks are back: CI is green and the agent changes are safe.'),
    sdk({
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 185_000,
      num_turns: 12,
      result: 'done',
      total_cost_usd: 0.84,
    }),
  ]
}

/** A task with six finished background subagents, so the task list collapses them. */
function manyRows(): Row[] {
  const rows: Row[] = [['prompt', { text: 'Research six competitors.' }]]
  for (let i = 1; i <= 6; i++) {
    const id = `toolu_seed_many_${String(i)}`
    rows.push(
      agent(id, `Competitor research ${String(i)}`, true),
      started({ task: `a_many_${String(i)}`, id, description: `Competitor research ${String(i)}`, background: true }),
      launched(id, `a_many_${String(i)}`),
    )
  }
  for (let i = 1; i <= 6; i++) {
    const id = `toolu_seed_many_${String(i)}`
    rows.push(
      notified(`a_many_${String(i)}`, id, i === 6 ? 'stopped' : 'completed', `Findings for competitor ${String(i)}.`),
    )
  }
  return rows
}

/** A session imported from a terminal: no task events, so background outcomes are unknown. */
function importedRows(): Row[] {
  return [
    ['prompt', { text: 'Map the LLM seams.' }],
    agent('toolu_seed_imported', 'Map voice-bot LLM seam', true),
    launched('toolu_seed_imported', 'a_imported', true),
    text('Waiting for the mapping agent.'),
  ]
}

/** A list written with TodoWrite, one done, one in progress and one to go, and one subagent. */
function todoRows(): Row[] {
  const todos = [
    { content: 'Read the code', status: 'completed', activeForm: 'Reading the code' },
    { content: 'Fix the bug', status: 'in_progress', activeForm: 'Fixing the bug' },
    { content: 'Run the tests', status: 'pending', activeForm: 'Running the tests' },
  ]
  return [
    ['prompt', { text: 'Fix the flaky reaper test.' }],
    tool('toolu_seed_todo', 'TodoWrite', { todos }),
    result('toolu_seed_todo', 'Todos have been modified successfully.'),
    agent('toolu_seed_todo_agent', 'Read flaky test log', false),
    completed('toolu_seed_todo_agent', 'a_todo', 'The reaper times out.'),
    text('Fixing the reaper timeout next.'),
  ]
}

export const SEEDS = { fanOut: fanOutRows, many: manyRows, imported: importedRows, todos: todoRows }

/** Writes an idle task with the given rows, a minute apart, into the server's database. */
export async function seedTask(title: string, cwd: string, rows: readonly Row[]): Promise<string> {
  const db = openSeedDb()
  const id = randomUUID()
  const ts = new Date().toISOString()
  await db.run(
    `INSERT INTO task (id, title, repo_id, cwd, worktree, status, created_at, updated_at)
     VALUES (?, ?, NULL, ?, 0, 'idle', ?, ?)`,
    id,
    title,
    cwd,
    ts,
    ts,
  )
  await db.run('BEGIN')
  for (const [index, [kind, payload]] of rows.entries()) {
    await db.message(id, kind, JSON.stringify(payload), new Date(START + index * 7000).toISOString())
  }
  await db.run('COMMIT')
  await db.close()
  return id
}
