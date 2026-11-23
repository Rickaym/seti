import { z } from 'zod'

/**
 * The parts of Codex app-server notifications Seti reads, from the schema `codex app-server
 * generate-ts` prints for the pinned version. Objects stay loose: Codex adds fields often.
 */
const text = z.string()
const callStatus = z.enum(['inProgress', 'completed', 'failed', 'declined', 'interrupted'])

export const userMessage = z.looseObject({
  content: z.array(z.looseObject({ type: text, text: text.optional(), path: text.optional() })),
})

export const agentMessage = z.looseObject({ text })

export const reasoning = z.looseObject({ summary: z.array(text) })

export const commandExecution = z.looseObject({
  command: text,
  cwd: text.nullish(),
  status: callStatus,
  processId: text.nullish(),
  commandActions: z.array(z.looseObject({ type: text, command: text })).nullish(),
  aggregatedOutput: text.nullish(),
  exitCode: z.number().nullish(),
})

export const fileChange = z.looseObject({
  status: callStatus,
  changes: z.array(
    z.looseObject({
      path: text,
      kind: z.looseObject({ type: z.enum(['add', 'delete', 'update']), move_path: text.nullish() }),
      diff: text,
    }),
  ),
})

export const mcpToolCall = z.looseObject({
  server: text,
  tool: text,
  status: callStatus,
  arguments: z.unknown(),
  result: z.looseObject({ content: z.array(z.unknown()) }).nullish(),
  error: z.looseObject({ message: text }).nullish(),
})

export const collabAgentToolCall = z.looseObject({
  tool: text,
  status: callStatus,
  receiverThreadIds: z.array(text),
  prompt: text.nullish(),
})

export const webSearch = z.looseObject({ query: text.nullish() })

/** A thread item: its type names its shape. */
const threadItem = z.looseObject({ type: text, id: text })

export const itemParams = z.looseObject({ item: threadItem, threadId: text.optional() })

const thread = z.looseObject({
  id: text,
  model: text.nullish(),
  parentThreadId: text.nullish(),
  environments: z.array(z.looseObject({ cwd: text })).nullish(),
})

export const threadStarted = z.looseObject({ thread })

const turnError = z.looseObject({ message: text })

const turn = z.looseObject({
  id: text,
  status: z.enum(['completed', 'interrupted', 'failed', 'inProgress']),
  items: z.array(threadItem),
  error: turnError.nullish(),
  durationMs: z.number().nullish(),
})

const tokens = z.looseObject({
  inputTokens: z.number(),
  cachedInputTokens: z.number(),
  cacheWriteInputTokens: z.number().optional(),
  outputTokens: z.number(),
  reasoningOutputTokens: z.number(),
})

export const tokenUsage = z.looseObject({
  tokenUsage: z.looseObject({ last: tokens, modelContextWindow: z.number().nullish() }),
})

export const planUpdate = z.looseObject({
  plan: z.array(z.looseObject({ step: text, status: z.enum(['pending', 'inProgress', 'completed']) })),
})

export const errorNotice = z.looseObject({
  error: turnError.extend({ codexErrorInfo: z.unknown().optional() }),
  willRetry: z.boolean(),
})

export const userInputRequest = z.looseObject({
  itemId: text,
  questions: z.array(
    z.looseObject({
      id: text,
      header: text.nullish(),
      question: text,
      options: z.array(z.looseObject({ label: text })).nullish(),
    }),
  ),
})

export type Item = z.infer<typeof threadItem>

export const turnParams = z.looseObject({ turn })

/** A message as Seti stores it: the notification or request unchanged, and the agent's thread. */
export const stored = z.looseObject({
  root: text,
  message: z.looseObject({ method: text, params: z.unknown().optional() }),
  reply: z.unknown().optional(),
  job: z.looseObject({ id: text, stopped: z.boolean().optional() }).optional(),
})

/** Codex's list of a thread's background terminals. */
export const backgroundList = z.looseObject({
  data: z.array(z.looseObject({ itemId: text, processId: text, command: text })),
})

/** Seti's answer to `item/tool/requestUserInput`: each question's answers by its id. */
export const userInputAnswer = z.looseObject({
  answers: z.record(text, z.looseObject({ answers: z.array(text) })),
})
