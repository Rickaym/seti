import type { ToolCall, ToolKind } from '../../events.js'
import { isRecord } from '../../lenient.js'
import { bool, filled, list, num, some, str } from './fields.js'

type Normalised = Omit<ToolCall, 'callId' | 'kind' | 'name' | 'input'>
type Reader = (input: unknown, callId: string) => Normalised

const run: Reader = (input) => ({
  shell: {
    action: 'run',
    ...some('command', str(input, 'command')),
    ...some('description', str(input, 'description')),
    ...some('background', bool(input, 'run_in_background')),
    ...some('timeoutMs', num(input, 'timeout')),
  },
})

const watch: Reader = (input) => ({
  shell: {
    action: 'watch',
    ...some('command', str(input, 'command')),
    ...some('description', str(input, 'description')),
    background: true,
  },
})

const onJob =
  (action: 'output' | 'stop'): Reader =>
  (input) => ({ shell: { action, ...some('job', str(input, 'shell_id') ?? str(input, 'bash_id')) } })

const readFile: Reader = (input) => {
  const path = str(input, 'file_path') ?? str(input, 'notebook_path')
  return { read: { paths: path === undefined ? [] : [path] } }
}

const write: Reader = (input) => ({
  edit: { changes: [{ path: str(input, 'file_path') ?? '', op: 'write', ...some('after', str(input, 'content')) }] },
})

const replace = (path: string, edit: unknown) => ({
  path,
  op: 'update' as const,
  ...some('before', str(edit, 'old_string')),
  ...some('after', str(edit, 'new_string')),
})

const edit: Reader = (input) => ({ edit: { changes: [replace(str(input, 'file_path') ?? '', input)] } })

const multiEdit: Reader = (input) => {
  const path = str(input, 'file_path') ?? ''
  return { edit: { changes: list(input, 'edits').map((one) => replace(path, one)) } }
}

const notebookEdit: Reader = (input) => ({
  edit: {
    changes: [{ path: str(input, 'notebook_path') ?? '', op: 'update', ...some('after', str(input, 'new_source')) }],
  },
})

const search: Reader = (input) => ({
  search: { ...some('pattern', str(input, 'pattern') ?? str(input, 'query')), ...some('path', str(input, 'path')) },
})

const toolSearch: Reader = (input) => ({ search: { ...some('pattern', str(input, 'query')), tools: true } })

const webSearch: Reader = (input) => ({ web: { ...some('query', str(input, 'query')) } })

const webFetch: Reader = (input) => ({ web: { ...some('url', str(input, 'url')) } })

const subagent: Reader = (input, callId) => ({
  subagent: {
    label: str(input, 'description') ?? 'Subagent',
    ...some('prompt', str(input, 'prompt')),
    ...some('agentType', str(input, 'subagent_type')),
    ...some('background', bool(input, 'run_in_background')),
    thread: callId,
  },
})

const PLAN_STATUSES = new Set(['pending', 'in_progress', 'completed'])

type PlanStatus = 'pending' | 'in_progress' | 'completed'

const planStatus = (value: unknown): value is PlanStatus => typeof value === 'string' && PLAN_STATUSES.has(value)

/** TodoWrite's items; one it cannot read is left out, and ids count from 1 as the list reads. */
const todoWrite: Reader = (input) => ({
  plan: {
    replace: list(input, 'todos').flatMap((todo, index) => {
      const text = filled(todo, 'content')
      const status = isRecord(todo) ? todo.status : undefined
      if (text === undefined || !planStatus(status)) {
        return []
      }
      return [{ id: String(index + 1), text, ...some('activeText', filled(todo, 'activeForm')), status }]
    }),
  },
})

const taskCreate: Reader = (input) => ({
  plan: {
    add: {
      text: filled(input, 'subject') ?? '',
      ...some('activeText', filled(input, 'activeForm')),
      status: 'pending',
    },
  },
})

const UPDATE_STATUSES = new Set([...PLAN_STATUSES, 'deleted'])

const taskUpdate: Reader = (input) => {
  const status = str(input, 'status')
  return {
    plan: {
      update: {
        id: str(input, 'taskId') ?? '',
        ...(status !== undefined && UPDATE_STATUSES.has(status) ? { status: status as PlanStatus | 'deleted' } : {}),
        ...some('text', str(input, 'subject')),
      },
    },
  }
}

const proposal: Reader = (input) => ({ plan: { ...some('proposal', str(input, 'plan')) } })

const question: Reader = (input) => ({
  question: {
    questions: list(input, 'questions').map((one) => ({
      text: str(one, 'question') ?? '',
      ...some('header', str(one, 'header')),
      options: list(one, 'options').flatMap((option) => {
        const label = str(option, 'label')
        return label === undefined ? [] : [label]
      }),
      ...some('multiple', bool(one, 'multiSelect')),
    })),
  },
})

const none: Reader = () => ({})

/** Claude Code's built-in tools by name: what each does and how its input reads. */
const TOOLS: ReadonlyMap<string, [ToolKind, Reader]> = new Map<string, [ToolKind, Reader]>([
  ['Bash', ['shell', run]],
  ['Monitor', ['shell', watch]],
  ['BashOutput', ['shell', onJob('output')]],
  ['KillBash', ['shell', onJob('stop')]],
  ['KillShell', ['shell', onJob('stop')]],
  ['Read', ['read', readFile]],
  ['NotebookRead', ['read', readFile]],
  ['Write', ['edit', write]],
  ['Edit', ['edit', edit]],
  ['MultiEdit', ['edit', multiEdit]],
  ['NotebookEdit', ['edit', notebookEdit]],
  ['Grep', ['search', search]],
  ['Glob', ['search', search]],
  ['ToolSearch', ['search', toolSearch]],
  ['WebSearch', ['web', webSearch]],
  ['WebFetch', ['web', webFetch]],
  ['Agent', ['subagent', subagent]],
  ['Task', ['subagent', subagent]],
  ['TodoWrite', ['plan', todoWrite]],
  ['TaskCreate', ['plan', taskCreate]],
  ['TaskUpdate', ['plan', taskUpdate]],
  ['TaskList', ['plan', none]],
  ['TaskGet', ['plan', none]],
  ['ExitPlanMode', ['plan', proposal]],
  ['AskUserQuestion', ['question', question]],
])

/** An MCP tool's server and name from Claude Code's `mcp__<server>__<tool>`, or null. */
function mcpName(name: string): { server: string; tool: string } | null {
  const parts = name.split('__')
  const [prefix, server] = parts
  if (prefix !== 'mcp' || server === undefined || parts.length < 3) {
    return null
  }
  return { server, tool: parts.slice(2).join('__') }
}

/** A Claude Code tool call in neutral form; the input stays as the vendor sent it. */
export function claudeToolCall(callId: string, name: string, input: unknown): ToolCall {
  const known = TOOLS.get(name)
  if (known !== undefined) {
    const [kind, read] = known
    return { callId, kind, name, input, ...read(input, callId) }
  }
  const mcp = mcpName(name)
  return mcp === null ? { callId, kind: 'other', name, input } : { callId, kind: 'mcp', name, input, mcp }
}
