import type { ToolCall } from '@seti/shared'
import type { PolicyCall, PolicyKind } from './types.js'

const filled = (paths: readonly string[]) => [...new Set(paths.filter((given) => given !== ''))]

const scalars = (input: unknown): Record<string, unknown> =>
  typeof input === 'object' && input !== null && !Array.isArray(input)
    ? Object.fromEntries(
        Object.entries(input).filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value)),
      )
    : {}

/** Paths a call reads: a file it opens, or the folder a file search looks in, the cwd by default. */
function readsOf(call: ToolCall): string[] {
  if (call.read !== undefined) {
    return filled(call.read.paths)
  }
  if (call.kind === 'search' && call.search?.tools !== true) {
    return [call.search?.path ?? '.']
  }
  return []
}

/** A runtime's thinking step is no action of its own, so the evaluator reads it as any other tool. */
const kindOf = (call: ToolCall): PolicyKind => (call.kind === 'think' ? 'other' : call.kind)

/** A neutral tool call as the evaluator reads it: the parts rules match, whatever the runtime. */
export function policyCall(call: ToolCall): PolicyCall {
  const command = call.shell?.action === 'run' ? call.shell.command : undefined
  const url = call.web?.url
  const agentType = call.kind === 'subagent' ? (call.subagent?.agentType ?? 'general-purpose') : undefined
  return {
    name: call.name,
    kind: kindOf(call),
    ...(command === undefined || command === '' ? {} : { command }),
    reads: readsOf(call),
    writes: filled((call.edit?.changes ?? []).map((change) => change.path)),
    ...(url === undefined ? {} : { url }),
    ...(call.mcp === undefined ? {} : { mcp: call.mcp }),
    ...(agentType === undefined ? {} : { agentType }),
    params: scalars(call.input),
  }
}
