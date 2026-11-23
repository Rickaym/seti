import type { PolicyCall, PolicyKind, PolicyMode } from './types.js'

const KINDS: Record<string, PolicyKind> = {
  Bash: 'shell',
  BashOutput: 'shell',
  KillShell: 'shell',
  Monitor: 'shell',
  Read: 'read',
  NotebookRead: 'read',
  LS: 'read',
  Glob: 'search',
  Grep: 'search',
  Write: 'edit',
  Edit: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
  WebFetch: 'web',
  WebSearch: 'web',
  Agent: 'subagent',
  Task: 'subagent',
  AskUserQuestion: 'question',
  ExitPlanMode: 'plan',
  EnterPlanMode: 'plan',
}

const READ_FIELDS: Record<string, string> = { Read: 'file_path', NotebookRead: 'notebook_path', LS: 'path' }
const SEARCH_TOOLS = new Set(['Glob', 'Grep'])
const WRITE_FIELDS: Record<string, string> = {
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
}

const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)

const scalars = (input: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(input).filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value)),
  )

function mcpOf(tool: string): { server: string; tool: string } {
  const rest = tool.slice('mcp__'.length)
  const split = rest.indexOf('__')
  return split <= 0 ? { server: rest, tool: '' } : { server: rest.slice(0, split), tool: rest.slice(split + 2) }
}

function readsOf(tool: string, input: Record<string, unknown>): string[] {
  const field = READ_FIELDS[tool]
  const given = field === undefined ? undefined : text(input[field])
  if (given !== undefined) {
    return [given]
  }
  return SEARCH_TOOLS.has(tool) ? [text(input.path) ?? '.'] : []
}

function writesOf(tool: string, input: Record<string, unknown>): string[] {
  const field = WRITE_FIELDS[tool]
  const given = field === undefined ? undefined : text(input[field])
  return given === undefined ? [] : [given]
}

/** A Claude Code tool call as the evaluator reads it. */
export function claudeCall(tool: string, input: Record<string, unknown>): PolicyCall {
  const isMcp = tool.startsWith('mcp__')
  const command = tool === 'Bash' ? text(input.command) : undefined
  const url = tool === 'WebFetch' ? text(input.url) : undefined
  const agentType = KINDS[tool] === 'subagent' ? (text(input.subagent_type) ?? 'general-purpose') : undefined
  return {
    name: tool,
    kind: isMcp ? 'mcp' : (KINDS[tool] ?? 'other'),
    ...(command === undefined ? {} : { command }),
    reads: readsOf(tool, input),
    writes: writesOf(tool, input),
    ...(url === undefined ? {} : { url }),
    ...(isMcp ? { mcp: mcpOf(tool) } : {}),
    ...(agentType === undefined ? {} : { agentType }),
    params: scalars(input),
  }
}

const MODES: Record<string, PolicyMode> = { auto: 'auto', bypassPermissions: 'bypass', plan: 'plan' }

/** Claude Code's permission mode as the evaluator's; any mode Seti does not run asks. */
export const policyMode = (claudeMode: string | undefined): PolicyMode => MODES[claudeMode ?? ''] ?? 'ask'
