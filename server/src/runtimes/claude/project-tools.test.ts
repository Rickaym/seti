import { projectClaude, type MessageBody, type RuntimeEvent, type ToolCall } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { shellCall } from '../../shell-fixtures.js'
import { agentCall, assistant, toolUse } from '../../subtask-fixtures.js'

const sdkOf = (body: MessageBody) => {
  if (body.kind !== 'sdk') {
    throw new Error('not an sdk row')
  }
  return body.payload
}

function callOf(body: MessageBody): ToolCall {
  const [event] = projectClaude(sdkOf(body))
  if (event?.type !== 'tool.started') {
    throw new Error(`expected a tool start, got ${String(event?.type)}`)
  }
  return event.call
}

const call = (name: string, input: Record<string, unknown>) => callOf(assistant([toolUse('toolu_1', name, input)]))

describe('Claude tool calls', () => {
  it('reads a shell command, its description, background flag and timeout', () => {
    const input = { command: 'pnpm test', description: 'Run tests', run_in_background: true, timeout: 600_000 }
    expect(callOf(shellCall('toolu_bash', input))).toEqual({
      callId: 'toolu_bash',
      kind: 'shell',
      name: 'Bash',
      input,
      shell: { action: 'run', command: 'pnpm test', description: 'Run tests', background: true, timeoutMs: 600_000 },
    })
  })

  it('reads a Monitor as a background watch and the job tools by the job they act on', () => {
    const watch = { command: 'kubectl rollout status deploy/api -w', description: 'Watch the rollout' }
    expect(call('Monitor', watch).shell).toEqual({ action: 'watch', ...watch, background: true })
    expect(call('BashOutput', { bash_id: 'b1' }).shell).toEqual({ action: 'output', job: 'b1' })
    expect(call('KillShell', { shell_id: 'b2' }).shell).toEqual({ action: 'stop', job: 'b2' })
    expect(call('KillBash', { shell_id: 'b3' })).toMatchObject({ kind: 'shell', shell: { action: 'stop', job: 'b3' } })
  })

  it('reads the file a read names', () => {
    expect(call('Read', { file_path: '/w/a.ts', offset: 10 })).toMatchObject({
      kind: 'read',
      read: { paths: ['/w/a.ts'] },
    })
    expect(call('NotebookRead', { notebook_path: '/w/n.ipynb' }).read).toEqual({ paths: ['/w/n.ipynb'] })
  })

  it('reads edits as the text they replace, without inventing a diff', () => {
    expect(call('Edit', { file_path: '/w/a.ts', old_string: 'a', new_string: 'b' })).toMatchObject({
      kind: 'edit',
      edit: { changes: [{ path: '/w/a.ts', op: 'update', before: 'a', after: 'b' }] },
    })
    expect(call('Write', { file_path: '/w/b.ts', content: 'x' }).edit).toEqual({
      changes: [{ path: '/w/b.ts', op: 'write', after: 'x' }],
    })
    const edits = [
      { old_string: 'one', new_string: '1' },
      { old_string: 'two', new_string: '2', replace_all: true },
    ]
    expect(call('MultiEdit', { file_path: '/w/c.ts', edits }).edit).toEqual({
      changes: [
        { path: '/w/c.ts', op: 'update', before: 'one', after: '1' },
        { path: '/w/c.ts', op: 'update', before: 'two', after: '2' },
      ],
    })
    expect(call('NotebookEdit', { notebook_path: '/w/n.ipynb', cell_id: 'c1', new_source: 'print(1)' }).edit).toEqual({
      changes: [{ path: '/w/n.ipynb', op: 'update', after: 'print(1)' }],
    })
  })

  it('reads searches and web calls', () => {
    expect(call('Grep', { pattern: 'TODO', path: 'src' })).toMatchObject({
      kind: 'search',
      search: { pattern: 'TODO', path: 'src' },
    })
    expect(call('Glob', { pattern: '**/*.ts' }).search).toEqual({ pattern: '**/*.ts' })
    expect(call('ToolSearch', { query: 'select:Read' }).search).toEqual({ pattern: 'select:Read' })
    expect(call('WebSearch', { query: 'zod 4' })).toMatchObject({ kind: 'web', web: { query: 'zod 4' } })
    expect(call('WebFetch', { url: 'https://example.com', prompt: 'p' }).web).toEqual({ url: 'https://example.com' })
  })

  it('reads a subagent call; its thread is the call id, as its messages carry', () => {
    expect(callOf(agentCall('toolu_agent', 'Review the diff', { run_in_background: true }))).toMatchObject({
      kind: 'subagent',
      name: 'Agent',
      subagent: {
        label: 'Review the diff',
        prompt: 'Do this: Review the diff',
        agentType: 'general-purpose',
        background: true,
        thread: 'toolu_agent',
      },
    })
    expect(call('Task', { prompt: 'p' }).subagent).toEqual({ label: 'Subagent', prompt: 'p', thread: 'toolu_1' })
  })

  it('reads TodoWrite as the whole list, leaving out items it cannot read', () => {
    const todos = [
      { content: 'Write tests', activeForm: 'Writing tests', status: 'completed' },
      { content: 'Ship', activeForm: ' ', status: 'in_progress' },
      { content: ' ', status: 'pending' },
      { content: 'Odd', status: 'blocked' },
    ]
    expect(call('TodoWrite', { todos }).plan).toEqual({
      replace: [
        { id: '1', text: 'Write tests', activeText: 'Writing tests', status: 'completed' },
        { id: '2', text: 'Ship', status: 'in_progress' },
      ],
    })
  })

  it('reads the task tools as one item added or changed, and the reads as no change', () => {
    expect(call('TaskCreate', { subject: 'Fix CI', activeForm: 'Fixing CI', description: 'd' }).plan).toEqual({
      add: { text: 'Fix CI', activeText: 'Fixing CI', status: 'pending' },
    })
    expect(call('TaskUpdate', { taskId: '3', status: 'completed' }).plan).toEqual({
      update: { id: '3', status: 'completed' },
    })
    expect(call('TaskUpdate', { taskId: '4', status: 'deleted', subject: 'Gone' }).plan).toEqual({
      update: { id: '4', status: 'deleted', text: 'Gone' },
    })
    expect(call('TaskUpdate', { taskId: '5', status: 'odd' }).plan).toEqual({ update: { id: '5' } })
    expect(call('TaskList', {})).toEqual({ callId: 'toolu_1', kind: 'plan', name: 'TaskList', input: {} })
    expect(call('TaskGet', { taskId: '1' }).kind).toBe('plan')
  })

  it('reads a plan put up for approval and a question for the user', () => {
    expect(call('ExitPlanMode', { plan: '1. Do it' })).toMatchObject({ kind: 'plan', plan: { proposal: '1. Do it' } })
    const questions = [
      {
        question: 'Which database?',
        header: 'Database',
        options: [{ label: 'Postgres', description: 'p' }, { label: 'SQLite' }, { description: 'no label' }],
        multiSelect: false,
      },
      { question: 'Anything else?', options: [] },
    ]
    expect(call('AskUserQuestion', { questions }).question).toEqual({
      questions: [
        { text: 'Which database?', header: 'Database', options: ['Postgres', 'SQLite'], multiple: false },
        { text: 'Anything else?', options: [] },
      ],
    })
  })

  it('reads an MCP tool by server and tool, whatever the tool name holds', () => {
    expect(call('mcp__seti__set_status', { text: 'x' })).toMatchObject({
      kind: 'mcp',
      mcp: { server: 'seti', tool: 'set_status' },
    })
    expect(call('mcp__github__pulls__create', {}).mcp).toEqual({ server: 'github', tool: 'pulls__create' })
    expect(call('mcp__broken', {}).kind).toBe('other')
  })

  it('keeps any other tool as other, with its input unchanged', () => {
    expect(call('Skill', { skill: 'graphify' })).toEqual({
      callId: 'toolu_1',
      kind: 'other',
      name: 'Skill',
      input: { skill: 'graphify' },
    })
  })

  it('does not throw on input of the wrong shape', () => {
    const odd = callOf(assistant([{ type: 'tool_use', id: 'toolu_x', name: 'Edit', input: 'not an object' }]))
    expect(odd.edit).toEqual({ changes: [{ path: '', op: 'update' }] })
    const events: RuntimeEvent[] = projectClaude(
      sdkOf(assistant([{ type: 'tool_use', id: 'toolu_y', name: 'TodoWrite' }])),
    )
    expect(events).toMatchObject([{ type: 'tool.started', call: { plan: { replace: [] } } }])
  })
})
