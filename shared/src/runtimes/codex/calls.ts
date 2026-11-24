import type { RuntimeEvent, ToolCall, ToolResult } from '../../events.js'
import { isRecord } from '../../lenient.js'
import { collabAgentToolCall, commandExecution, fileChange, mcpToolCall, webSearch, type Item } from './shapes.js'
import { shellWord } from './shell-word.js'

type Ended = Extract<RuntimeEvent, { type: 'tool.ended' }>
type Status = Ended['status']

/** Codex runs each command as `<shell> -lc <command>`, the command quoted as one shell word. */
const WRAPPER = /^\S*\/(?:ba|z|)sh -l?c (.+)$/s

/** The command inside Codex's shell wrapper, or the whole text when it has none. */
export function unwrapShell(command: string): string {
  const quoted = WRAPPER.exec(command)?.[1]
  return quoted === undefined ? command : (shellWord(quoted) ?? command)
}

const OPS = { add: 'create', delete: 'delete', update: 'update' } as const

type Reader = (item: Item) => Omit<ToolCall, 'callId'>

const shell: Reader = (raw) => {
  const item = commandExecution.parse(raw)
  const command = unwrapShell(item.command)
  return {
    kind: 'shell',
    name: 'Bash',
    input: { command, ...(item.cwd === null || item.cwd === undefined ? {} : { cwd: item.cwd }) },
    shell: { action: 'run', command },
  }
}

const edit: Reader = (raw) => {
  const item = fileChange.parse(raw)
  const changes = item.changes.map(({ path, kind, diff }) =>
    kind.type === 'update' && typeof kind.move_path === 'string'
      ? { path, op: 'move' as const, diff, to: kind.move_path }
      : { path, op: OPS[kind.type], diff },
  )
  const name = changes.every((change) => change.op === 'create') ? 'Write' : 'Edit'
  return { kind: 'edit', name, input: { changes: item.changes }, edit: { changes } }
}

const mcp: Reader = (raw) => {
  const item = mcpToolCall.parse(raw)
  return {
    kind: 'mcp',
    name: `mcp__${item.server}__${item.tool}`,
    input: item.arguments,
    mcp: { server: item.server, tool: item.tool },
  }
}

/** The first line of a subagent's prompt, as its label. */
const labelOf = (prompt: string | null | undefined) => (prompt ?? '').split('\n')[0]?.trim() ?? ''

const collab: Reader = (raw) => {
  const item = collabAgentToolCall.parse(raw)
  const [to = ''] = item.receiverThreadIds
  const input = { tool: item.tool, prompt: item.prompt ?? null, receivers: item.receiverThreadIds }
  if (item.tool === 'spawnAgent') {
    const prompt = item.prompt ?? undefined
    return {
      kind: 'subagent',
      name: item.tool,
      input,
      subagent: { label: labelOf(prompt), thread: to, ...(prompt === undefined ? {} : { prompt }) },
    }
  }
  const sends = ['sendInput', 'sendMessage', 'followupTask'].includes(item.tool)
  return { kind: 'other', name: item.tool, input, ...(sends && to !== '' ? { send: { to } } : {}) }
}

const web: Reader = (raw) => {
  const query = webSearch.parse(raw).query ?? undefined
  return { kind: 'web', name: 'WebSearch', input: { query }, web: query === undefined ? {} : { query } }
}

const READERS: Partial<Record<string, Reader>> = {
  commandExecution: shell,
  fileChange: edit,
  mcpToolCall: mcp,
  collabAgentToolCall: collab,
  webSearch: web,
}

/** Whether an item of this type is a tool call. */
export const isCall = (type: string) => READERS[type] !== undefined

/** The tool call an item stands for, or null for an item that is none; throws on a bad shape. */
export function callOf(item: Item): ToolCall | null {
  const read = READERS[item.type]?.(item)
  return read === undefined ? null : { callId: item.id, ...read }
}

const ENDS: Record<string, Status> = {
  completed: 'ok',
  failed: 'error',
  declined: 'denied',
  interrupted: 'cancelled',
  inProgress: 'error',
}

/** The text of an MCP result's text parts, joined. */
function mcpText(content: readonly unknown[]): string {
  return content.flatMap((part) => (isRecord(part) && typeof part.text === 'string' ? [part.text] : [])).join('\n')
}

interface Outcome {
  status: string
  result: ToolResult
}

const NO_RESULT: ToolResult = { text: '', images: 0 }

const OUTCOMES: Partial<Record<string, (item: Item) => Outcome>> = {
  commandExecution: (item) => {
    const run = commandExecution.parse(item)
    const exit = typeof run.exitCode === 'number' ? { exitCode: run.exitCode } : {}
    return { status: run.status, result: { text: run.aggregatedOutput ?? '', images: 0, ...exit } }
  },
  mcpToolCall: (item) => {
    const call = mcpToolCall.parse(item)
    const text = call.error?.message ?? mcpText(call.result?.content ?? [])
    return { status: call.status, result: { text, images: 0 } }
  },
  fileChange: (item) => ({ status: fileChange.parse(item).status, result: NO_RESULT }),
  collabAgentToolCall: (item) => ({ status: collabAgentToolCall.parse(item).status, result: NO_RESULT }),
}

const outcomeOf = (item: Item): Outcome => OUTCOMES[item.type]?.(item) ?? { status: 'completed', result: NO_RESULT }

/** The end of the call an item stands for, from the item as completed. */
export function endOf(item: Item, thread: string): Ended {
  const { status, result } = outcomeOf(item)
  return { v: 1, thread, type: 'tool.ended', callId: item.id, status: ENDS[status] ?? 'error', result }
}
