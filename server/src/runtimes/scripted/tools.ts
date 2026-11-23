import type { ToolCall, ToolKind } from '@seti/shared'
import type { ScriptedCall } from './dialect.js'

type Args = Record<string, unknown>

/** The argument under the key as a property of the same name, when it is text. */
const field = <K extends string>(args: Args, key: string, as: K): Partial<Record<K, string>> => {
  const value = args[key]
  return typeof value === 'string' ? ({ [as]: value } as Record<K, string>) : {}
}

const textOf = (args: Args, key: string): string => {
  const value = args[key]
  return typeof value === 'string' ? value : ''
}

/** Questions as the scripted runtime writes them: text and options. */
function questionsOf(value: unknown): { text: string; options: string[] }[] {
  return (Array.isArray(value) ? value : []).map((question: unknown) => {
    const entry = typeof question === 'object' && question !== null ? (question as Args) : {}
    const options = Array.isArray(entry.options) ? entry.options.filter((o) => typeof o === 'string') : []
    return { text: textOf(entry, 'text'), options }
  })
}

/** The scripted runtime's tools: each one's kind and the part of the call its kind reads. */
const TOOLS = new Map<string, [ToolKind, (args: Args) => Partial<ToolCall>]>([
  ['sh', ['shell', (args) => ({ shell: { action: 'run', command: textOf(args, 'cmd') } })]],
  ['cat', ['read', (args) => ({ read: { paths: [textOf(args, 'path')] } })]],
  [
    'patch',
    [
      'edit',
      (args) => ({ edit: { changes: [{ path: textOf(args, 'path'), op: 'update', ...field(args, 'diff', 'diff') }] } }),
    ],
  ],
  [
    'grep',
    ['search', (args) => ({ search: { ...field(args, 'pattern', 'pattern'), ...field(args, 'path', 'path') } })],
  ],
  ['fetch', ['web', (args) => ({ web: field(args, 'url', 'url') })]],
  ['ask', ['question', (args) => ({ question: { questions: questionsOf(args.questions) } })]],
])

/** A tool of a tool server, which the scripted runtime names `<server>.<tool>`. */
const MCP_NAME = /^([\w-]+)\.([\w-]+)$/

const GATED = new Set(['sh', 'patch', 'fetch', 'ask'])

/** Whether the runtime asks Seti before the call runs: shell, edits, web, questions, tool servers. */
export const isGated = (tool: string): boolean => GATED.has(tool) || MCP_NAME.test(tool)

/** A scripted call as a neutral tool call; a tool the map does not know is `other`. */
export function scriptedToolCall(call: ScriptedCall): ToolCall {
  const base = { callId: call.id, name: call.tool, input: call.args }
  const mcp = MCP_NAME.exec(call.tool)
  if (mcp !== null) {
    return { ...base, kind: 'mcp', mcp: { server: mcp[1] ?? '', tool: mcp[2] ?? '' } }
  }
  const known = TOOLS.get(call.tool)
  return known === undefined ? { ...base, kind: 'other' } : { ...base, kind: known[0], ...known[1](call.args) }
}
