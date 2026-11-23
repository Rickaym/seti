import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { CONTEXT_WINDOW_KEY, projectClaude, type MessageBody } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { fakeBackground, fakeMessage } from '../../fake-sdk.js'
import { backgroundChanged, shellNotification, shellStarted, shellUpdated } from '../../shell-fixtures.js'
import { taskNotification, taskProgress, taskStarted, taskUpdated } from '../../subtask-fixtures.js'

const project = (body: MessageBody) => {
  if (body.kind !== 'sdk') {
    throw new Error('not an sdk row')
  }
  return projectClaude(body.payload)
}

const system = (subtype: string, extra: Record<string, unknown> = {}) =>
  projectClaude(fakeMessage('system', { subtype, ...extra }) as unknown as SDKMessage)

const startFields = { task_id: 'b1', tool_use_id: 'toolu_b', description: 'Serve', task_type: 'local_bash' }
const progressFields = {
  task_id: 'a1',
  description: 'progress',
  usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1 },
}
const endFields = { task_id: 'b1', output_file: '/work/t/b1.output', summary: 'Done' }

describe('Claude session and compaction messages', () => {
  it('reads a session start with its mode and how its servers connected', () => {
    const init = {
      model: 'claude-opus-5-5',
      permissionMode: 'auto',
      cwd: '/w',
      tools: [],
      mcp_servers: [
        { name: 'seti', status: 'connected' },
        { name: 'github', status: 'failed', source: 'user' },
      ],
    }
    expect(system('init', init)).toEqual([
      {
        v: 1,
        thread: '',
        type: 'session.started',
        sessionId: 'fake-session',
        model: 'claude-opus-5-5',
        mode: 'auto',
        servers: [
          { name: 'seti', status: 'connected' },
          { name: 'github', status: 'failed' },
        ],
        cwd: '/w',
        plugins: [],
        pluginErrors: [],
      },
    ])
    const plugins = {
      plugins: [{ name: 'p', path: '/p', version: '1' }],
      plugin_errors: [{ plugin: 'q', message: 'x' }],
    }
    expect(system('init', { model: 'haiku', ...plugins })).toMatchObject([
      { plugins: [{ name: 'p', path: '/p', version: '1' }], pluginErrors: [{ plugin: 'q', message: 'x' }] },
    ])
    expect(system('init', { model: 'haiku' })).toMatchObject([{ mode: null, servers: [] }])
  })

  it('reads compaction starting, ending, failing and the boundary it leaves', () => {
    expect(system('status', { status: 'compacting' })).toEqual([
      { v: 1, thread: '', type: 'compaction', phase: 'started' },
    ])
    expect(system('status', { status: null, compact_result: 'failed', compact_error: 'too long' })).toMatchObject([
      { type: 'compaction', phase: 'failed', error: 'too long' },
    ])
    expect(system('status', { status: null, compact_result: 'failed' })).toMatchObject([{ error: 'no reason given' }])
    expect(system('status', { status: null })).toMatchObject([{ type: 'compaction', phase: 'stopped' }])
    expect(system('compact_boundary', { compact_metadata: { trigger: 'auto', pre_tokens: 190_000 } })).toEqual([
      { v: 1, thread: '', type: 'compaction', phase: 'done', trigger: 'auto', before: 190_000 },
    ])
    const measured = { compact_metadata: { trigger: 'manual', pre_tokens: 82_000 }, [CONTEXT_WINDOW_KEY]: 100_000 }
    expect(system('compact_boundary', measured)).toMatchObject([{ phase: 'done', before: 82_000, window: 100_000 }])
    const timed = { compact_metadata: { trigger: 'auto', pre_tokens: 9, post_tokens: 3, duration_ms: 1200 } }
    expect(system('compact_boundary', timed)).toMatchObject([{ before: 9, after: 3, durationMs: 1200 }])
  })

  it('reads retries, model fallbacks, runtime denials and slash command output', () => {
    expect(system('api_retry', { attempt: 1, max_retries: 10, error_status: 529, error: 'overloaded' })).toEqual([
      { v: 1, thread: '', type: 'notice', code: 'api_retry', text: 'overloaded', status: 529 },
    ])
    expect(system('api_retry', { error_status: null, error: 'unknown' })).toEqual([
      { v: 1, thread: '', type: 'notice', code: 'api_retry', text: 'unknown' },
    ])
    const fallback = {
      trigger: 'refusal',
      direction: 'retry',
      original_model: 'claude-opus-5-5',
      fallback_model: 'claude-sonnet-5',
      content: 'Switched to Sonnet for this request.',
    }
    expect(system('model_refusal_fallback', fallback)).toEqual([
      {
        v: 1,
        thread: '',
        type: 'model.changed',
        from: 'claude-opus-5-5',
        to: 'claude-sonnet-5',
        reason: 'refusal',
        text: 'Switched to Sonnet for this request.',
      },
    ])
    const refused = {
      ...fallback,
      scope: 'local',
      request_id: 'req_1',
      api_refusal_category: 'cyber',
      api_refusal_explanation: 'Flagged.',
      api_refusal_cyber_verification: { type: 'inactive' },
    }
    expect(system('model_refusal_fallback', refused)).toMatchObject([
      {
        refusal: { requestId: 'req_1', scope: 'local', category: 'cyber', explanation: 'Flagged.', verification: {} },
      },
    ])
    const denial = {
      tool_name: 'Bash',
      tool_use_id: 'toolu_9',
      decision_reason_type: 'classifier',
      decision_reason: 'Deletes files outside the project',
      message: 'Permission denied',
    }
    expect(system('permission_denied', denial)).toEqual([
      {
        v: 1,
        thread: '',
        type: 'policy.denied',
        callId: 'toolu_9',
        tool: 'Bash',
        by: 'runtime',
        classifier: true,
        reason: 'Deletes files outside the project',
        text: 'Permission denied',
      },
    ])
    const ruled = system('permission_denied', { ...denial, decision_reason: undefined, decision_reason_type: 'rule' })
    expect(ruled).toMatchObject([{ text: 'Permission denied' }])
    expect(ruled[0]).not.toHaveProperty('reason')
    expect(ruled[0]).not.toHaveProperty('classifier')
    expect(system('code_change_published', { url: 'https://github.com/o/r/pull/1', action: 'created' })).toEqual([
      { v: 1, thread: '', type: 'change.published', url: 'https://github.com/o/r/pull/1', action: 'created' },
    ])
    expect(system('code_change_published', { action: 'created' })).toMatchObject([{ type: 'vendor' }])
    expect(system('local_command_output', { content: 'Cost: $0.10' })).toMatchObject([
      { type: 'vendor', name: 'system/local_command_output' },
    ])
  })

  it('keeps the subtypes Seti does not read as vendor', () => {
    expect(system('hook_response', { hook_name: 'h' })).toEqual([
      { v: 1, thread: '', type: 'vendor', name: 'system/hook_response' },
    ])
    expect(system('thinking_tokens')).toMatchObject([{ type: 'vendor', name: 'system/thinking_tokens' }])
    expect(system('constructor')).toMatchObject([{ type: 'vendor', name: 'system/constructor' }])
  })
})

describe('Claude background work', () => {
  it('reads a subagent task from start through progress to its end', () => {
    expect(
      project(taskStarted({ taskId: 'a1', toolUseId: 'toolu_a', description: 'Review', background: true })),
    ).toEqual([
      {
        v: 1,
        thread: '',
        type: 'job.started',
        jobId: 'a1',
        callId: 'toolu_a',
        kind: 'subagent',
        label: 'Review',
        background: true,
        agentType: 'general-purpose',
      },
    ])
    expect(project(taskProgress('a1', 'toolu_a', 'Grep', 3))).toEqual([
      {
        v: 1,
        thread: '',
        type: 'job.progress',
        jobId: 'a1',
        callId: 'toolu_a',
        label: 'progress',
        lastTool: 'Grep',
        usage: { tokens: 3000, toolUses: 3, durationMs: 6000 },
      },
    ])
    expect(project(taskNotification('a1', 'toolu_a', 'completed', 'Reviewed.'))).toEqual([
      {
        v: 1,
        thread: '',
        type: 'job.ended',
        jobId: 'a1',
        callId: 'toolu_a',
        status: 'completed',
        summary: 'Reviewed.',
        output: expect.stringMatching(/\/tasks\/a1\.output$/) as unknown,
        usage: { tokens: 20_000, toolUses: 9, durationMs: 90_000 },
      },
    ])
    expect(project(taskNotification('a2', undefined, 'stopped', 'Stopped.'))).toMatchObject([{ callId: null }])
    expect(system('task_progress', { ...progressFields, summary: 'Reading the diff' })).toMatchObject([
      { type: 'job.progress', summary: 'Reading the diff' },
    ])
    expect(project(taskUpdated('a1', { is_backgrounded: true }))).toEqual([
      { v: 1, thread: '', type: 'job.updated', jobId: 'a1', background: true },
    ])
  })

  it('reads who started a shell and why the runtime stopped one on its own', () => {
    expect(system('task_started', { ...startFields, owned_by_subagent: true })).toMatchObject([
      { type: 'job.started', bySubagent: true },
    ])
    expect(system('task_started', startFields)[0]).not.toHaveProperty('bySubagent')
    const stopped = (summary: string) => system('task_notification', { ...endFields, status: 'stopped', summary })[0]
    expect(stopped('Stopped: background time limit reached')).toMatchObject({ stopCause: 'time_limit' })
    expect(stopped('Stopped: the machine is running low on memory')).toMatchObject({ stopCause: 'low_memory' })
    expect(stopped('Stopped by the user')).not.toHaveProperty('stopCause')
    expect(
      system('task_notification', { ...endFields, status: 'failed', summary: 'background time limit' })[0],
    ).not.toHaveProperty('stopCause')
    expect(system('task_notification', { ...endFields, status: 'completed', output_file: '' })[0]).not.toHaveProperty(
      'output',
    )
  })

  it('reads a background shell, its updates and the exit code its end reports', () => {
    expect(
      project(shellStarted({ shellId: 'b1', toolUseId: 'toolu_b', description: 'Serve', background: true })),
    ).toMatchObject([{ type: 'job.started', jobId: 'b1', callId: 'toolu_b', kind: 'shell', label: 'Serve' }])
    expect(project(shellUpdated('b1', { status: 'killed', end_time: 1_795_334_392_000, error: 'gone' }))).toEqual([
      {
        v: 1,
        thread: '',
        type: 'job.updated',
        jobId: 'b1',
        status: 'killed',
        endedAt: new Date(1_795_334_392_000).toISOString(),
        error: 'gone',
      },
    ])
    expect(project(taskUpdated('b1', { status: 'running' }))).toEqual([
      { v: 1, thread: '', type: 'job.updated', jobId: 'b1', status: 'running' },
    ])
    expect(
      project(shellNotification('b1', 'failed', 'Background command "Serve" failed (exit code 137)')),
    ).toMatchObject([{ type: 'job.ended', jobId: 'b1', callId: 'toolu_b1', status: 'failed', exitCode: 137 }])
    expect(project(shellNotification('b2', 'completed', 'Done'))[0]).not.toHaveProperty('exitCode')
  })

  it('reads a task of another type as other', () => {
    expect(system('task_started', { task_id: 'w1', description: 'Workflow', task_type: 'workflow' })).toMatchObject([
      { type: 'job.started', jobId: 'w1', callId: null, kind: 'other' },
    ])
  })

  it('reads the background work still running', () => {
    expect(project(backgroundChanged(['b1', 'Serve'], ['b2', 'Watch']))).toEqual([
      {
        v: 1,
        thread: '',
        type: 'background.changed',
        jobs: [
          { id: 'b1', kind: 'shell', label: 'Serve' },
          { id: 'b2', kind: 'shell', label: 'Watch' },
        ],
      },
    ])
    expect(projectClaude(fakeBackground('a1') as unknown as SDKMessage)).toMatchObject([
      { type: 'background.changed', jobs: [{ id: 'a1', kind: 'subagent', label: 'a1' }] },
    ])
  })
})
