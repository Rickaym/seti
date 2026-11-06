import type { DigestLine, MessageBody, MessageRow, TaskDigest } from '@seti/shared'
import { beforeAll, describe, expect, it } from 'vitest'
import { createApp } from './app.js'
import { messages, tasks } from './db.js'
import { buildDigest } from './digest.js'
import { USER_AUTH } from './test-auth.js'

const SESSION = '5f0c3a52-9d7e-4d3a-8f5e-2b8f3c1e7a10'
let nextId = 1

function row(body: unknown, at = '2026-09-27T10:00:00.000Z'): MessageRow {
  return { ...(body as MessageBody), id: nextId++, task_id: 'task', outward: [], created_at: at }
}

const sdk = (payload: Record<string, unknown>, at?: string) =>
  row({ kind: 'sdk', payload: { session_id: SESSION, uuid: `u-${String(nextId)}`, ...payload } }, at)

const assistant = (content: unknown[], parent: string | null = null) =>
  sdk({
    type: 'assistant',
    parent_tool_use_id: parent,
    message: {
      id: `msg_${String(nextId)}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-4-1',
      content,
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 20 },
    },
  })

const toolResult = (id: string, content: unknown, isError = false) =>
  sdk({
    type: 'user',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }],
    },
    tool_use_result: { stdout: typeof content === 'string' ? content : '', stderr: '', interrupted: false },
  })

const result = (subtype: string, extra: Record<string, unknown> = {}) =>
  sdk({
    type: 'result',
    subtype,
    duration_ms: 125_400,
    duration_api_ms: 90_000,
    is_error: subtype !== 'success',
    num_turns: 6,
    total_cost_usd: 0.42,
    usage: { input_tokens: 100, output_tokens: 200 },
    permission_denials: [],
    ...extra,
  })

const FILE = Array.from({ length: 40 }, (_, i) => `${String(i + 1).padStart(6)}\tconst line${String(i)} = ${String(i)}`)

function realisticTranscript(): MessageRow[] {
  return [
    row({ kind: 'prompt', payload: { text: 'Fix the login redirect\nand open a PR' } }, '2026-09-27T10:00:00.000Z'),
    sdk({
      type: 'system',
      subtype: 'init',
      cwd: '/repo',
      model: 'claude-opus-4-1',
      permissionMode: 'bypassPermissions',
    }),
    assistant([
      { type: 'thinking', thinking: 'Look at the router first.', signature: 'sig' },
      { type: 'text', text: "I'll check the working tree first." },
      { type: 'tool_use', id: 'toolu_git', name: 'Bash', input: { command: 'git status', description: 'Status' } },
    ]),
    toolResult('toolu_git', 'On branch main\nYour branch is up to date.\n\nnothing to commit'),
    assistant([{ type: 'tool_use', id: 'toolu_read', name: 'Read', input: { file_path: '/repo/src/login.ts' } }]),
    toolResult('toolu_read', FILE.join('\n')),
    assistant([
      {
        type: 'tool_use',
        id: 'toolu_edit',
        name: 'Edit',
        input: { file_path: '/repo/src/login.ts', old_string: 'a', new_string: 'b' },
      },
    ]),
    toolResult('toolu_edit', [{ type: 'text', text: 'String to replace not found in file.' }], true),
    assistant([
      { type: 'tool_use', id: 'toolu_task', name: 'Task', input: { description: 'Find callers', prompt: 'Search' } },
    ]),
    assistant([{ type: 'text', text: 'Subagent chatter' }], 'toolu_task'),
    toolResult('toolu_task', [{ type: 'text', text: 'Two callers: auth.ts and app.ts' }]),
    assistant([
      { type: 'tool_use', id: 'toolu_cu', name: 'mcp__clickup__clickup_get_task', input: { task_id: '86c1' } },
    ]),
    toolResult('toolu_cu', '{"name":"Login bug"}'),
    assistant([{ type: 'text', text: 'Opened   https://github.com/e2e/app/pull/12\n\nwith the fix.' }]),
    result('success', { result: 'Opened the PR.' }),
  ]
}

const texts = (lines: DigestLine[]) => lines.map((line) => `${line.kind} ${line.text}`)

describe('buildDigest', () => {
  it('condenses a turn into prompts, agent text, tool calls with results and the turn end', () => {
    expect(texts(buildDigest(realisticTranscript()))).toEqual([
      'user Fix the login redirect and open a PR',
      "agent I'll check the working tree first.",
      'tool Ran: git status. Result: On branch main (+2 lines)',
      'tool Ran: Read /repo/src/login.ts.',
      'tool Ran: Edit /repo/src/login.ts. Failed: String to replace not found in file.',
      'tool Ran: Task Find callers. Result: Two callers: auth.ts and app.ts',
      'tool Ran: clickup: clickup_get_task. Result: {"name":"Login bug"}',
      'agent Opened https://github.com/e2e/app/pull/12 with the fix.',
      'status Turn finished in 2m 5s',
    ])
  })

  it('keeps the time of the message each line came from', () => {
    const [first] = buildDigest(realisticTranscript())
    expect(first?.at).toBe('2026-09-27T10:00:00.000Z')
  })

  it('shows a call whose result has not arrived yet without an outcome', () => {
    const rows = [assistant([{ type: 'tool_use', id: 'toolu_long', name: 'Bash', input: { command: 'pnpm test' } }])]
    expect(texts(buildDigest(rows))).toEqual(['tool Ran: pnpm test.'])
  })

  it('covers PR updates, auto turns, interruptions, shell runs, errors and failed turns', () => {
    const rows = [
      row({
        kind: 'input',
        payload: {
          source: 'pr',
          kind: 'ci_failed',
          subject: 'e2e/app#12',
          title: 'CI failed on e2e/app#12',
          body: 'lint failed',
          url: 'https://github.com/e2e/app/pull/12',
        },
      }),
      row({ kind: 'prompt', payload: { text: '', auto: true, inputs: 1 } }),
      row({ kind: 'prompt', payload: { text: 'Stop, use the other branch', interrupted: true } }),
      row({
        kind: 'shell',
        payload: {
          run_id: 'r1',
          command: 'pnpm lint',
          cwd: '/repo',
          started_at: '2026-09-27T10:05:00.000Z',
          exit_code: 1,
          signal: null,
          ended_by: null,
          duration_ms: 3000,
          stdout: '',
          stderr: 'src/a.ts: 1 problem\nsrc/b.ts: 2 problems',
        },
      }),
      row({
        kind: 'shell',
        payload: {
          run_id: 'r2',
          command: 'sleep 999',
          cwd: '/repo',
          started_at: '2026-09-27T10:06:00.000Z',
          exit_code: null,
          signal: 'SIGTERM',
          ended_by: 'timeout',
          duration_ms: 600_000,
          stdout: '',
          stderr: '',
        },
      }),
      row({ kind: 'seti', payload: { error: 'Claude Code process exited with code 1' } }),
      row({ kind: 'seti', payload: { error: 'Seti control turned on', seti_control: true } }),
      result('error_max_turns'),
      result('success', { is_error: true, result: 'API Error: 529 overloaded' }),
      sdk({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 1 } }),
      sdk({
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: { trigger: 'auto', pre_tokens: 164_000 },
        seti_context_window: 200_000,
      }),
    ]
    expect(texts(buildDigest(rows))).toEqual([
      'update CI failed on e2e/app#12',
      'status Started a turn for 1 update',
      'status Interrupted the running turn',
      'user Stop, use the other branch',
      'shell Ran in shell: pnpm lint. Exit 1: src/a.ts: 1 problem (+1 lines)',
      'shell Ran in shell: sleep 999. Stopped by the time limit.',
      'status Error: Claude Code process exited with code 1',
      'status Seti control turned on',
      'status Turn stopped at the turn limit',
      'status Turn failed: API Error: 529 overloaded',
      'status Compacted the conversation',
      'status Compacted the conversation at 82%',
    ])
  })

  it('clips long text to one line', () => {
    const [line] = buildDigest([row({ kind: 'prompt', payload: { text: 'word '.repeat(400) } })])
    expect(line?.text.length).toBeLessThanOrEqual(600)
    expect(line?.text.endsWith('...')).toBe(true)
  })
})

describe('GET /api/tasks/:id/digest', () => {
  const app = createApp({ access: null, verify: null })
  const get = async (path: string) => app.request(`/api/tasks${path}`, { headers: { host: 'localhost', ...USER_AUTH } })

  beforeAll(async () => {
    await tasks.insert({ id: 'digest-task', title: 'Digest', repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })
    for (let i = 0; i < 40; i++) {
      await messages.insert('digest-task', { kind: 'prompt', payload: { text: `step ${String(i)}` } }, [])
    }
  })

  it('returns the newest lines, 30 by default', async () => {
    const res = await get('/digest-task/digest')
    expect(res.status).toBe(200)
    const { lines } = ((await res.json()) as { data: TaskDigest }).data
    expect(lines).toHaveLength(30)
    expect(lines.at(-1)).toMatchObject({ kind: 'user', text: 'step 39' })
    expect(lines[0]).toMatchObject({ text: 'step 10' })
  })

  it('honours the limit and rejects values outside 1 to 200', async () => {
    const res = await get('/digest-task/digest?limit=3')
    const { lines } = ((await res.json()) as { data: TaskDigest }).data
    expect(lines.map((line) => line.text)).toEqual(['step 37', 'step 38', 'step 39'])
    expect((await get('/digest-task/digest?limit=201')).status).toBe(400)
    expect((await get('/digest-task/digest?limit=0')).status).toBe(400)
    expect((await get('/missing/digest')).status).toBe(404)
  })
})
