import type { SDKAssistantMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { TODO_STATUSES, type AgentTodo, type MessageRow, type TodoStatus } from '@seti/shared'

type UserBlock = Exclude<SDKUserMessage['message']['content'], string>[number]
type ToolResultBlock = Extract<UserBlock, { type: 'tool_result' }>

/** Claude Code's todo tools: TodoWrite, or the task tools that replace it in newer versions. */
const TODO_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'])
const CREATED = /^Task #(\S+) created successfully/

interface Call {
  name: string
  input: unknown
}

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined
}

function text(value: unknown, key: string): string | null {
  const found = field(value, key)
  return typeof found === 'string' && found.trim() !== '' ? found : null
}

const isStatus = (value: unknown): value is TodoStatus =>
  typeof value === 'string' && (TODO_STATUSES as readonly string[]).includes(value)

function resultText(block: ToolResultBlock): string {
  const { content } = block
  if (typeof content === 'string') {
    return content
  }
  return (content ?? []).flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n')
}

/** TodoWrite's whole list; items it cannot read are left out. */
function writtenList(input: unknown): AgentTodo[] {
  const todos = field(input, 'todos')
  if (!Array.isArray(todos)) {
    return []
  }
  return todos.flatMap((todo: unknown, index) => {
    const content = text(todo, 'content')
    const status = field(todo, 'status')
    if (content === null || !isStatus(status)) {
      return []
    }
    return [{ id: String(index + 1), content, active_form: text(todo, 'activeForm'), status }]
  })
}

/**
 * The todo list an agent keeps with Claude Code's own tools, folded from its messages in id
 * order. A call counts once its result arrives without an error. TodoWrite of a subagent keeps
 * that subagent's own list, so only the agent's own count; the task tools share one list per
 * session, so every call counts. A new session starts an empty list, as Claude Code does.
 */
export class TodoIndex {
  lastId = 0
  private items: AgentTodo[] = []
  private session: string | null = null
  private readonly calls = new Map<string, Call>()

  /** Folds one message in; true when it changed the list. Older messages are ignored. */
  apply(row: MessageRow): boolean {
    if (row.id <= this.lastId) {
      return false
    }
    this.lastId = row.id
    if (row.kind !== 'sdk') {
      return false
    }
    const m = row.payload
    if (m.type === 'system' && m.subtype === 'init') {
      return this.started(m.session_id)
    }
    if (m.type === 'assistant') {
      this.noteCalls(m)
      return false
    }
    return m.type === 'user' ? this.applyResults(m) : false
  }

  todos(): AgentTodo[] {
    return this.items.map((todo) => ({ ...todo }))
  }

  private started(session: string): boolean {
    const fresh = this.session !== null && this.session !== session
    this.session = session
    if (!fresh || this.items.length === 0) {
      return false
    }
    this.items = []
    return true
  }

  private noteCalls(m: SDKAssistantMessage): void {
    for (const block of m.message.content) {
      if (block.type !== 'tool_use' || !TODO_TOOLS.has(block.name)) {
        continue
      }
      if (block.name === 'TodoWrite' && m.parent_tool_use_id !== null) {
        continue
      }
      this.calls.set(block.id, { name: block.name, input: block.input })
    }
  }

  private applyResults(m: SDKUserMessage): boolean {
    if (typeof m.message.content === 'string') {
      return false
    }
    const results = m.message.content.filter((block) => block.type === 'tool_result')
    const before = JSON.stringify(this.items)
    for (const block of results) {
      const call = this.calls.get(block.tool_use_id)
      if (call === undefined) {
        continue
      }
      this.calls.delete(block.tool_use_id)
      if (block.is_error !== true) {
        this.applyCall(call, block, results.length === 1 ? m.tool_use_result : undefined)
      }
    }
    return JSON.stringify(this.items) !== before
  }

  private applyCall(call: Call, block: ToolResultBlock, output: unknown): void {
    switch (call.name) {
      case 'TodoWrite':
        this.items = writtenList(call.input)
        return
      case 'TaskCreate':
        this.created(call.input, block, output)
        return
      case 'TaskUpdate':
        this.updated(call.input, output)
        return
      case 'TaskList':
        this.listed(output)
        return
      case 'TaskGet':
        this.got(output)
        return
      default:
    }
  }

  private created(input: unknown, block: ToolResultBlock, output: unknown): void {
    const id = text(field(output, 'task'), 'id') ?? CREATED.exec(resultText(block))?.[1] ?? null
    const content = text(input, 'subject')
    if (id === null || content === null) {
      return
    }
    const todo: AgentTodo = { id, content, active_form: text(input, 'activeForm'), status: 'pending' }
    this.items = [...this.items.filter((item) => item.id !== id), todo]
  }

  private updated(input: unknown, output: unknown): void {
    const id = text(input, 'taskId')
    if (id === null || field(output, 'success') === false) {
      return
    }
    const status = field(input, 'status')
    if (status === 'deleted') {
      this.items = this.items.filter((item) => item.id !== id)
      return
    }
    this.items = this.items.map((item) =>
      item.id === id
        ? {
            ...item,
            content: text(input, 'subject') ?? item.content,
            active_form: text(input, 'activeForm') ?? item.active_form,
            status: isStatus(status) ? status : item.status,
          }
        : item,
    )
  }

  /** TaskList reports the whole list, which settles any call this index missed. */
  private listed(output: unknown): void {
    const tasks = field(output, 'tasks')
    if (!Array.isArray(tasks)) {
      return
    }
    const known = new Map(this.items.map((item) => [item.id, item]))
    this.items = tasks.flatMap((task: unknown) => {
      const id = text(task, 'id')
      const content = text(task, 'subject')
      const status = field(task, 'status')
      if (id === null || content === null || !isStatus(status)) {
        return []
      }
      return [{ id, content, active_form: known.get(id)?.active_form ?? null, status }]
    })
  }

  private got(output: unknown): void {
    const task = field(output, 'task')
    const id = text(task, 'id')
    const status = field(task, 'status')
    if (id === null || !isStatus(status)) {
      return
    }
    this.items = this.items.map((item) =>
      item.id === id ? { ...item, content: text(task, 'subject') ?? item.content, status } : item,
    )
  }
}

export function deriveTodos(rows: readonly MessageRow[]): AgentTodo[] {
  const index = new TodoIndex()
  for (const row of rows) {
    index.apply(row)
  }
  return index.todos()
}
