import type { MessageBody } from '@seti/shared'

/** SDK messages shaped like the ones Claude Code streams for subagents, for tests. */
const SESSION = 'a646309c-9f34-4d47-ba20-53367a64f2f7'
let counter = 0

const uuid = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`

const sdk = (payload: Record<string, unknown>): MessageBody =>
  ({ kind: 'sdk', payload: { session_id: SESSION, uuid: uuid(), ...payload } }) as MessageBody

export const assistant = (content: unknown[], parent: string | null = null): MessageBody =>
  sdk({
    type: 'assistant',
    parent_tool_use_id: parent,
    message: {
      id: `msg_${String(counter)}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5-5',
      content,
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 20 },
    },
  })

export const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({
  type: 'tool_use',
  id,
  name,
  input,
})

export const agentCall = (id: string, description: string, extra: Record<string, unknown> = {}, parent?: string) =>
  assistant(
    [
      toolUse(id, 'Agent', {
        description,
        subagent_type: 'general-purpose',
        prompt: `Do this: ${description}`,
        ...extra,
      }),
    ],
    parent ?? null,
  )

export const toolResult = (
  id: string,
  content: unknown,
  options: { parent?: string; isError?: boolean; output?: unknown } = {},
): MessageBody =>
  sdk({
    type: 'user',
    parent_tool_use_id: options.parent ?? null,
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: id, content, ...(options.isError === true ? { is_error: true } : {}) },
      ],
    },
    ...(options.output === undefined ? {} : { tool_use_result: options.output }),
  })

const launchText = (agentId: string) =>
  [
    'Async agent launched successfully. (This tool result is internal metadata.)',
    `agentId: ${agentId} (internal ID - do not mention to user.)`,
    'The agent is working in the background. You will be notified automatically when it completes.',
  ].join('\n')

/** The tool result of a background Agent call; imported rows lack the structured output. */
export const launched = (id: string, agentId: string, imported = false) =>
  toolResult(id, [{ type: 'text', text: launchText(agentId) }], {
    ...(imported
      ? {}
      : {
          output: {
            isAsync: true,
            status: 'async_launched',
            agentId,
            description: 'launched',
            prompt: 'p',
            outputFile: `/tmp/tasks/${agentId}.output`,
          },
        }),
  })

export const completedResult = (id: string, agentId: string, report: string) =>
  toolResult(
    id,
    [
      { type: 'text', text: report },
      { type: 'text', text: `agentId: ${agentId} (for resuming)\n<usage>total_tokens: 5100</usage>` },
    ],
    {
      output: {
        status: 'completed',
        agentId,
        prompt: 'p',
        content: [{ type: 'text', text: report }],
        totalTokens: 5100,
        totalToolUseCount: 4,
        totalDurationMs: 61_000,
        usage: { input_tokens: 1, output_tokens: 2 },
      },
    },
  )

interface Started {
  taskId: string
  toolUseId: string
  description: string
  background: boolean
  type?: 'local_agent' | 'local_bash'
  depth?: number
}

export const taskStarted = (s: Started) =>
  sdk({
    type: 'system',
    subtype: 'task_started',
    task_id: s.taskId,
    tool_use_id: s.toolUseId,
    description: s.description,
    is_backgrounded: s.background,
    task_type: s.type ?? 'local_agent',
    ...(s.type === 'local_bash' ? {} : { subagent_type: 'general-purpose', spawn_depth: s.depth ?? 1, prompt: 'p' }),
  })

export const taskProgress = (taskId: string, toolUseId: string, lastTool: string, toolUses: number) =>
  sdk({
    type: 'system',
    subtype: 'task_progress',
    task_id: taskId,
    tool_use_id: toolUseId,
    description: 'progress',
    subagent_type: 'general-purpose',
    usage: { total_tokens: 1000 * toolUses, tool_uses: toolUses, duration_ms: 2000 * toolUses },
    last_tool_name: lastTool,
  })

export const taskNotification = (
  taskId: string,
  toolUseId: string | undefined,
  status: 'completed' | 'failed' | 'stopped',
  summary: string,
) =>
  sdk({
    type: 'system',
    subtype: 'task_notification',
    task_id: taskId,
    ...(toolUseId === undefined ? {} : { tool_use_id: toolUseId }),
    status,
    output_file: `/tmp/tasks/${taskId}.output`,
    summary,
    usage: { total_tokens: 20_000, tool_uses: 9, duration_ms: 90_000 },
  })

export const taskUpdated = (taskId: string, patch: Record<string, unknown>) =>
  sdk({ type: 'system', subtype: 'task_updated', task_id: taskId, patch })

export const bash = (id: string, command: string, parent?: string) =>
  assistant([toolUse(id, 'Bash', { command, description: command })], parent ?? null)
