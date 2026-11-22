import { TURN_COST_KEY, type MessageBody, type MessageRow } from '@seti/shared'
import { FLEET, fleetTranscript } from '../demo/content/history.js'
import type { Row } from '../demo/content/transcript.js'
import {
  cartTranscript,
  checkoutTranscript,
  guideTranscript,
  infraTranscript,
  ordersTranscript,
} from '../demo/content/transcripts.js'
import {
  backgroundChanged,
  backgroundResult,
  movedResult,
  plainResult,
  shellCall,
  shellNotification,
  shellStarted,
  shellUpdated,
} from '../shell-fixtures.js'
import {
  agentCall,
  assistant,
  bash,
  completedResult,
  launched,
  taskNotification,
  taskProgress,
  taskStarted,
  taskUpdated,
  toolResult,
  toolUse,
} from '../subtask-fixtures.js'

/** A recorded transcript the golden tests render through every transcript reader. */
export interface GoldenTranscript {
  name: string
  rows: MessageRow[]
}

const START = Date.parse('2026-11-20T09:00:00.000Z')

/** Stored rows with ids and times in order, as a task's transcript reads back. */
function stored(name: string, bodies: readonly (MessageBody | Row)[]): GoldenTranscript {
  const rows = bodies.map((body, index) => {
    const [kind, payload] = Array.isArray(body) ? body : [body.kind, body.payload]
    const base = { id: index + 1, task_id: name, outward: [], created_at: new Date(START + index * 7000).toISOString() }
    return { ...base, kind, payload } as MessageRow
  })
  return { name, rows }
}

let uuid = 0

const sdk = (payload: Record<string, unknown>): MessageBody =>
  ({ kind: 'sdk', payload: { session_id: 'golden', uuid: `golden-${String(++uuid)}`, ...payload } }) as MessageBody

const prompt = (text: string, extra: Record<string, unknown> = {}): MessageBody => ({
  kind: 'prompt',
  payload: { text, ...extra },
})

const say = (text: string, parent: string | null = null) => assistant([{ type: 'text', text }], parent)

const init = (session: string) =>
  sdk({ type: 'system', subtype: 'init', session_id: session, model: 'claude-opus-5-5', permissionMode: 'auto' })

const result = (extra: Record<string, unknown> = {}) =>
  sdk({
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 42_000,
    num_turns: 3,
    result: 'Done.',
    total_cost_usd: 1.2,
    [TURN_COST_KEY]: 0.4,
    ...extra,
  })

const userText = (content: unknown, parent: string | null = null) =>
  sdk({ type: 'user', parent_tool_use_id: parent, message: { role: 'user', content } })

const shells = (): GoldenTranscript =>
  stored('shells', [
    prompt('Start the dev server and watch the build.'),
    init('s-shells'),
    shellCall('toolu_serve', { command: 'pnpm dev', description: 'Serve', run_in_background: true }),
    shellStarted({ shellId: 'b1', toolUseId: 'toolu_serve', description: 'Serve', background: true }),
    backgroundResult('toolu_serve', 'b1'),
    shellCall('toolu_watch', { command: 'kubectl rollout status deploy/api -w', description: 'Watch' }, 'Monitor'),
    shellStarted({ shellId: 'b2', toolUseId: 'toolu_watch', description: 'Watch', background: true }),
    toolResult('toolu_watch', 'Monitor started (task b2).'),
    shellCall('toolu_slow', { command: 'pnpm build', description: 'Build' }),
    shellStarted({ shellId: 'b3', toolUseId: 'toolu_slow', description: 'Build', background: false }),
    movedResult('toolu_slow', 'b3'),
    backgroundChanged(['b1', 'Serve'], ['b2', 'Watch'], ['b3', 'Build']),
    shellCall('toolu_out', { bash_id: 'b1' }, 'BashOutput'),
    plainResult('toolu_out', 'ready on :5173'),
    say('The server is up; the build runs in the background.'),
    result(),
    shellUpdated('b2', { status: 'completed', end_time: START + 90_000 }),
    shellNotification('b3', 'failed', 'Background command "Build" failed (exit code 1)'),
    shellCall('toolu_kill', { shell_id: 'b1' }, 'KillShell'),
    toolResult('toolu_kill', 'Shell b1 killed'),
    shellNotification('b1', 'stopped', 'Background command "Serve" was stopped'),
    result({ num_turns: 0, origin: { kind: 'task-notification' }, result: '' }),
  ])

const subagents = (): GoldenTranscript =>
  stored('subagents', [
    prompt('Review the PR with two agents and fix what they find.'),
    init('s-agents'),
    agentCall('toolu_rev', 'Review the API', { run_in_background: true }),
    taskStarted({ taskId: 'ag1', toolUseId: 'toolu_rev', description: 'Review the API', background: true }),
    launched('toolu_rev', 'ag1'),
    agentCall('toolu_sync', 'Check the docs'),
    taskStarted({ taskId: 'ag2', toolUseId: 'toolu_sync', description: 'Check the docs', background: false }),
    say('Reading the docs.', 'toolu_sync'),
    bash('toolu_sub_ls', 'ls docs', 'toolu_sync'),
    toolResult('toolu_sub_ls', 'setup.md\nprotocol.md', { parent: 'toolu_sync' }),
    taskProgress('ag1', 'toolu_rev', 'Grep', 4),
    completedResult('toolu_sync', 'ag2', 'The docs match the code.'),
    agentCall('toolu_bad', 'Broken agent'),
    toolResult('toolu_bad', 'Agent type not found', { isError: true }),
    say('One reviewer still runs.'),
    result(),
    taskUpdated('ag1', { status: 'running' }),
    taskNotification('ag1', 'toolu_rev', 'completed', 'Found two unchecked inputs.'),
    say('Fixing the two inputs the reviewer found.'),
    result({ origin: { kind: 'task-notification' } }),
  ])

const todoCalls = (): GoldenTranscript =>
  stored('todos', [
    prompt('Plan the migration, then do it.'),
    init('s-todos'),
    assistant([
      toolUse('toolu_tw', 'TodoWrite', {
        todos: [
          { content: 'Write the migration', activeForm: 'Writing the migration', status: 'in_progress' },
          { content: 'Backfill', activeForm: 'Backfilling', status: 'pending' },
        ],
      }),
    ]),
    toolResult('toolu_tw', 'Todos have been modified successfully.'),
    assistant(
      [toolUse('toolu_sub_tw', 'TodoWrite', { todos: [{ content: 'Sub item', status: 'pending' }] })],
      'toolu_x',
    ),
    toolResult('toolu_sub_tw', 'ok', { parent: 'toolu_x' }),
    assistant([toolUse('toolu_tc', 'TaskCreate', { subject: 'Verify', activeForm: 'Verifying', description: 'd' })]),
    toolResult('toolu_tc', 'Task #3 created successfully: Verify'),
    assistant([toolUse('toolu_tu', 'TaskUpdate', { taskId: '3', status: 'in_progress' })]),
    toolResult('toolu_tu', 'Updated task #3 status', { output: { success: true, taskId: '3' } }),
    assistant([toolUse('toolu_td', 'TaskUpdate', { taskId: '2', status: 'deleted' })]),
    toolResult('toolu_td', 'Updated task #2'),
    assistant([toolUse('toolu_tl', 'TaskList', {})]),
    toolResult('toolu_tl', '#3 [in_progress] Verify', {
      output: { tasks: [{ id: '3', subject: 'Verify', status: 'in_progress' }] },
    }),
    say('The plan is in place.'),
    result(),
    init('s-todos-2'),
    say('A new session starts with an empty list.'),
    result(),
  ])

const turns = (): GoldenTranscript =>
  stored('turns', [
    prompt('/compact'),
    init('s-turns'),
    sdk({ type: 'system', subtype: 'status', status: 'compacting' }),
    sdk({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 150_000 } }),
    sdk({ type: 'system', subtype: 'status', status: null }),
    result({ num_turns: 0, result: '' }),
    prompt('/cost'),
    userText('<local-command-stdout>Total cost: $1.20</local-command-stdout>'),
    prompt('Open a PR for the fix, then ask me about the release.'),
    init('s-turns'),
    assistant([
      { type: 'thinking', thinking: 'Push first, then open the PR.', signature: 's' },
      toolUse('toolu_push', 'Bash', { command: 'git push -u origin fix/retry', description: 'Push' }),
    ]),
    toolResult('toolu_push', 'To github.com:acme/api.git\n * [new branch]      fix/retry -> fix/retry'),
    bash('toolu_pr', 'gh pr create --fill'),
    toolResult('toolu_pr', 'https://github.com/acme/api/pull/42'),
    assistant([toolUse('toolu_mcp', 'mcp__github__add_issue_comment', { body: 'Fixed', issue_number: 41 })]),
    toolResult('toolu_mcp', 'Comment added'),
    assistant([toolUse('toolu_web', 'WebFetch', { url: 'https://example.com/notes', prompt: 'p' })]),
    toolResult('toolu_web', 'Blocked by the allowlist', { isError: true }),
    sdk({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, error_status: 529, error: 'overloaded' }),
    say('Opened https://github.com/acme/api/pull/42.\n\nShould I tag the release now?'),
    result({ result: 'Opened https://github.com/acme/api/pull/42.\n\nShould I tag the release now?' }),
    prompt('Not yet. Stop for now.', { interrupted: true }),
    bash('toolu_long', 'sleep 600'),
    toolResult('toolu_long', '[Request interrupted by user for tool use]', { isError: true }),
    userText([{ type: 'text', text: '[Request interrupted by user for tool use]' }]),
    result({ subtype: 'error_during_execution', is_error: true, result: undefined, errors: ['aborted'] }),
    prompt('Try again with the other model.'),
    sdk({
      type: 'system',
      subtype: 'model_refusal_fallback',
      trigger: 'refusal',
      direction: 'retry',
      original_model: 'claude-opus-5-5',
      fallback_model: 'claude-sonnet-5',
      request_id: null,
      content: 'Switched to Sonnet for this request.',
    }),
    sdk({
      type: 'system',
      subtype: 'status',
      status: null,
      compact_result: 'failed',
      compact_error: 'Prompt too long',
    }),
    sdk({
      type: 'system',
      subtype: 'permission_denied',
      tool_name: 'Bash',
      tool_use_id: 'toolu_rm',
      decision_reason_type: 'classifier',
      decision_reason: 'Deletes files outside the project',
      message: 'denied',
    }),
    assistant([toolUse('toolu_q', 'AskUserQuestion', { questions: [{ question: 'Tag now?', options: [] }] })]),
    toolResult('toolu_q', 'User answered: later'),
    assistant([toolUse('toolu_plan', 'ExitPlanMode', { plan: '1. Tag\n2. Publish' })]),
    toolResult('toolu_plan', 'User approved the plan'),
    result({ is_error: true, result: 'API Error: 401 authentication_failed', api_error_status: 401 }),
  ])

/** Every golden transcript: the demo's, the fleet's first two, and scenarios built from fixtures. */
export function goldenCorpus(): GoldenTranscript[] {
  uuid = 0
  return [
    stored('checkout', checkoutTranscript().rows),
    stored('orders', ordersTranscript().rows),
    stored('infra', infraTranscript().rows),
    stored('cart', cartTranscript().rows),
    stored('guide', guideTranscript().rows),
    ...FLEET.slice(0, 2).map((seed) => stored(`fleet-${seed.id.slice(0, 8)}`, fleetTranscript(seed).rows)),
    shells(),
    subagents(),
    todoCalls(),
    turns(),
  ]
}
