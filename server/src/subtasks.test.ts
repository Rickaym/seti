import type { MessageBody, MessageRow, SubtaskBrief } from '@seti/shared'
import { describe, expect, it } from 'vitest'
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
} from './subtask-fixtures.js'
import { deriveSubtasks, SubtaskIndex } from './subtasks.js'

const START = Date.parse('2026-09-27T07:50:00.000Z')

function rows(...bodies: MessageBody[]): MessageRow[] {
  return bodies.map((body, index) => ({
    ...body,
    id: index + 1,
    task_id: 'task',
    outward: [],
    created_at: new Date(START + index * 10_000).toISOString(),
  }))
}

function only(subtasks: SubtaskBrief[], id: string): SubtaskBrief {
  const found = subtasks.find((subtask) => subtask.tool_use_id === id)
  if (!found) {
    throw new Error(`no subtask ${id}`)
  }
  return found
}

describe('deriveSubtasks', () => {
  it('follows a foreground subagent from its call to its final report', () => {
    const transcript = rows(
      agentCall('toolu_fg', 'Map the LLM seam', { run_in_background: false }),
      taskStarted({ taskId: 'a01', toolUseId: 'toolu_fg', description: 'Map the LLM seam', background: false }),
      bash('toolu_inner', 'rg llm', 'toolu_fg'),
      toolResult('toolu_inner', 'src/llm.ts', { parent: 'toolu_fg' }),
      taskProgress('a01', 'toolu_fg', 'Bash', 1),
    )
    const running = deriveSubtasks(transcript, 0)
    expect(running).toEqual([
      expect.objectContaining({
        tool_use_id: 'toolu_fg',
        description: 'Map the LLM seam',
        subagent_type: 'general-purpose',
        background: false,
        status: 'running',
        sdk_task_id: 'a01',
        progress: { description: 'progress', last_tool: 'Bash', summary: null },
        usage: { total_tokens: 1000, tool_uses: 1, duration_ms: 2000 },
        message_id: 1,
        parent_tool_use_id: null,
        ended_at: null,
      }),
    ])

    const done = deriveSubtasks(
      [...transcript, ...rows(completedResult('toolu_fg', 'a01', '## Seam\nThe seam is src/llm.ts.')).map(shift(5))],
      0,
    )
    expect(done[0]).toMatchObject({
      status: 'completed',
      summary: 'Seam',
      usage: { total_tokens: 5100, tool_uses: 4, duration_ms: 61_000 },
      ended_at: new Date(START + 50_000).toISOString(),
    })
  })

  it('keeps a background subagent running after its launch result until the notification', () => {
    const transcript = rows(
      agentCall('toolu_bg', 'Slack digest Friday'),
      taskStarted({ taskId: 'a02', toolUseId: 'toolu_bg', description: 'Slack digest Friday', background: true }),
      launched('toolu_bg', 'a02'),
      assistant([{ type: 'text', text: 'Started the digest in the background.' }]),
      taskProgress('a02', 'toolu_bg', 'mcp__plugin_slack_slack__slack_search_public_and_private', 3),
    )
    expect(only(deriveSubtasks(transcript, 0), 'toolu_bg')).toMatchObject({ status: 'running', background: true })

    const notified = [
      ...transcript,
      ...rows(taskNotification('a02', 'toolu_bg', 'completed', 'Digest: Slack, Friday\n\n- item')).map(shift(5)),
    ]
    const index = new SubtaskIndex()
    for (const row of notified) {
      index.apply(row)
    }
    expect(index.find('toolu_bg', 0)).toMatchObject({
      status: 'completed',
      summary: 'Digest: Slack, Friday',
      result: 'Digest: Slack, Friday\n\n- item',
      prompt: 'Do this: Slack digest Friday',
      usage: { total_tokens: 20_000, tool_uses: 9, duration_ms: 90_000 },
    })
  })

  it('treats run_in_background as background before the SDK reports', () => {
    const [subtask] = deriveSubtasks(rows(agentCall('toolu_flag', 'Flagged', { run_in_background: true })), 0)
    expect(subtask?.background).toBe(true)
  })

  it('nests a subagent started by another one under it', () => {
    const transcript = rows(
      agentCall('toolu_outer', 'Plan the release'),
      taskStarted({ taskId: 'a10', toolUseId: 'toolu_outer', description: 'Plan the release', background: true }),
      launched('toolu_outer', 'a10'),
      agentCall('toolu_inner_agent', 'Check CI', { run_in_background: false }, 'toolu_outer'),
      taskStarted({
        taskId: 'a11',
        toolUseId: 'toolu_inner_agent',
        description: 'Check CI',
        background: false,
        depth: 2,
      }),
      bash('toolu_gh', 'gh pr checks', 'toolu_inner_agent'),
      completedResult('toolu_inner_agent', 'a11', 'CI is green.'),
    )
    const subtasks = deriveSubtasks(transcript, 0)
    expect(subtasks.map((s) => [s.tool_use_id, s.parent_tool_use_id, s.status])).toEqual([
      ['toolu_outer', null, 'running'],
      ['toolu_inner_agent', 'toolu_outer', 'completed'],
    ])
  })

  it('reports failed and stopped subagents', () => {
    const transcript = rows(
      agentCall('toolu_fail', 'Broken', { run_in_background: false }),
      toolResult('toolu_fail', 'Agent type "nope" not found', { isError: true }),
      agentCall('toolu_stop', 'Long poll'),
      taskStarted({ taskId: 'a20', toolUseId: 'toolu_stop', description: 'Long poll', background: true }),
      launched('toolu_stop', 'a20'),
      taskNotification('a20', 'toolu_stop', 'stopped', 'Long poll'),
      agentCall('toolu_killed', 'Killed'),
      taskStarted({ taskId: 'a21', toolUseId: 'toolu_killed', description: 'Killed', background: true }),
      taskUpdated('a21', { status: 'killed', end_time: START + 500_000 }),
    )
    const subtasks = deriveSubtasks(transcript, 0)
    expect(only(subtasks, 'toolu_fail')).toMatchObject({ status: 'failed', summary: 'Agent type "nope" not found' })
    expect(only(subtasks, 'toolu_stop').status).toBe('stopped')
    expect(only(subtasks, 'toolu_killed')).toMatchObject({
      status: 'stopped',
      ended_at: new Date(START + 500_000).toISOString(),
    })
  })

  it('leaves background Bash tasks out', () => {
    const transcript = rows(
      bash('toolu_sh', 'pnpm test'),
      taskStarted({
        taskId: 'b01',
        toolUseId: 'toolu_sh',
        description: 'Run tests',
        background: false,
        type: 'local_bash',
      }),
      taskUpdated('b01', { is_backgrounded: true }),
      toolResult('toolu_sh', 'Command running in background with ID: b01'),
      taskNotification('b01', 'toolu_sh', 'completed', 'Background command "Run tests" completed (exit code 0)'),
    )
    expect(deriveSubtasks(transcript, 0)).toEqual([])
  })

  it('ends a subagent without an outcome once the query closes', () => {
    const transcript = rows(
      agentCall('toolu_live', 'Live one'),
      taskStarted({ taskId: 'a30', toolUseId: 'toolu_live', description: 'Live one', background: true }),
      launched('toolu_live', 'a30'),
      agentCall('toolu_imported', 'Imported one'),
      launched('toolu_imported', 'a31', true),
    )
    const closed = deriveSubtasks(transcript, null)
    expect(only(closed, 'toolu_live').status).toBe('stopped')
    expect(only(closed, 'toolu_imported')).toMatchObject({ status: 'unknown', background: true })

    const laterQuery = deriveSubtasks(transcript, 4)
    expect(only(laterQuery, 'toolu_live').status).toBe('stopped')
    expect(only(laterQuery, 'toolu_imported').status).toBe('running')
  })

  it('reads imported rows, which carry no structured output or task events', () => {
    const transcript = rows(
      assistant([toolUse('toolu_task', 'Task', { description: 'Old style', prompt: 'p', subagent_type: 'Explore' })]),
      toolResult('toolu_task', [{ type: 'text', text: 'Found three call sites.' }]),
    )
    expect(deriveSubtasks(transcript, null)).toEqual([
      expect.objectContaining({ tool_use_id: 'toolu_task', status: 'completed', subagent_type: 'Explore' }),
    ])
  })

  it('follows a subagent that SendMessage resumed', () => {
    const transcript = rows(
      agentCall('toolu_first', 'Resolve conflicts'),
      taskStarted({ taskId: 'a40', toolUseId: 'toolu_first', description: 'Resolve conflicts', background: true }),
      launched('toolu_first', 'a40'),
      taskNotification('a40', undefined, 'stopped', 'Background agent did not finish before the session ended'),
      assistant([toolUse('toolu_send', 'SendMessage', { to: 'a40', message: 'Carry on' })]),
      toolResult('toolu_send', '{"success":true,"message":"Resuming agent a40"}'),
      taskStarted({ taskId: 'a40', toolUseId: 'toolu_resume', description: 'Resolve conflicts', background: true }),
    )
    const [resumed] = deriveSubtasks(transcript, 0)
    expect(resumed).toMatchObject({ status: 'running', tool_use_ids: ['toolu_first', 'toolu_send', 'toolu_resume'] })

    const finished = [
      ...transcript,
      ...rows(taskNotification('a40', 'toolu_resume', 'completed', 'Merged.')).map(shift(7)),
    ]
    expect(deriveSubtasks(finished, 0)[0]).toMatchObject({ status: 'completed', summary: 'Merged.' })
  })

  it('only reads rows newer than the ones it has seen', () => {
    const index = new SubtaskIndex()
    const [call, started] = rows(
      agentCall('toolu_once', 'Once'),
      taskStarted({ taskId: 'a50', toolUseId: 'toolu_once', description: 'Once', background: true }),
    )
    if (!call || !started) {
      throw new Error('rows missing')
    }
    expect(index.apply(call)).toBe(true)
    expect(index.apply(call)).toBe(false)
    expect(index.apply(started)).toBe(true)
    expect(index.briefs(0)).toHaveLength(1)
    expect(index.lastId).toBe(started.id)
  })
})

function shift(by: number) {
  return (row: MessageRow): MessageRow => ({
    ...row,
    id: row.id + by,
    created_at: new Date(Date.parse(row.created_at) + by * 10_000).toISOString(),
  })
}
