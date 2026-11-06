import type { MessageBody } from '@seti/shared'

/** SDK messages shaped like the ones Claude Code streams for background shells, for tests. */
const SESSION = '6a58e9d6-6259-4ddf-9dd5-8807e5dde609'
let counter = 0

const uuid = () => `00000000-0000-4000-9000-${String(++counter).padStart(12, '0')}`

const sdk = (payload: Record<string, unknown>): MessageBody =>
  ({ kind: 'sdk', payload: { session_id: SESSION, uuid: uuid(), ...payload } }) as MessageBody

/** Where Claude Code writes a background command's output, under its per-user temp dir. */
export const outputFile = (shellId: string, tmp = '/tmp') =>
  `${tmp}/claude-1000/-home-user-work-demo/${SESSION}/tasks/${shellId}.output`

export const shellCall = (toolUseId: string, input: Record<string, unknown>, tool = 'Bash', parent?: string) =>
  sdk({
    type: 'assistant',
    parent_tool_use_id: parent ?? null,
    message: {
      id: `msg_${String(counter)}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5-5',
      content: [{ type: 'tool_use', id: toolUseId, name: tool, input, caller: { type: 'direct' } }],
      stop_reason: null,
      usage: { input_tokens: 2, output_tokens: 16 },
    },
  })

interface Started {
  shellId: string
  toolUseId: string
  description: string
  background: boolean
  subagent?: boolean
}

export const shellStarted = (s: Started) =>
  sdk({
    type: 'system',
    subtype: 'task_started',
    task_id: s.shellId,
    ...(s.subagent === true ? { owned_by_subagent: true } : {}),
    tool_use_id: s.toolUseId,
    description: s.description,
    is_backgrounded: s.background,
    task_type: 'local_bash',
  })

export const backgroundResult = (toolUseId: string, shellId: string, tmp = '/tmp') =>
  sdk({
    type: 'user',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [
        {
          tool_use_id: toolUseId,
          type: 'tool_result',
          content:
            `Command running in background with ID: ${shellId}. Output is being written to: ` +
            `${outputFile(shellId, tmp)}. You will be notified when it completes. To check interim output, use ` +
            'Read on that file path.\nSession cwd remains /home/user/work/demo; directory changes made by the ' +
            'backgrounded command do not apply to subsequent commands.',
          is_error: false,
        },
      ],
    },
    tool_use_result: {
      stdout: '',
      stderr: '',
      interrupted: false,
      isImage: false,
      noOutputExpected: false,
      backgroundTaskId: shellId,
    },
  })

export const movedResult = (toolUseId: string, shellId: string) =>
  sdk({
    type: 'user',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [
        {
          tool_use_id: toolUseId,
          type: 'tool_result',
          content:
            `Command did not complete within its 600s timeout and was moved to the background (ID: ${shellId}). ` +
            `Output is being written to: ${outputFile(shellId)}. You will be notified when it completes.`,
          is_error: false,
        },
      ],
    },
  })

export const plainResult = (toolUseId: string, text: string) =>
  sdk({
    type: 'user',
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ tool_use_id: toolUseId, type: 'tool_result', content: text }] },
    tool_use_result: { stdout: text, stderr: '', interrupted: false, isImage: false, noOutputExpected: false },
  })

export const shellUpdated = (shellId: string, patch: Record<string, unknown>) =>
  sdk({ type: 'system', subtype: 'task_updated', task_id: shellId, patch })

export const shellNotification = (
  shellId: string,
  status: 'completed' | 'failed' | 'stopped',
  summary: string,
  file = outputFile(shellId),
) =>
  sdk({
    type: 'system',
    subtype: 'task_notification',
    task_id: shellId,
    tool_use_id: `toolu_${shellId}`,
    status,
    output_file: file,
    summary,
  })

export const backgroundChanged = (...shells: [id: string, description: string][]) =>
  sdk({
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: shells.map(([id, description]) => ({ task_id: id, task_type: 'local_bash', description })),
  })
