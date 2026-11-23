import {
  TODO_STATUSES,
  type AgentTodo,
  type MessageRow,
  type TodoStatus,
  type ToolCall,
  nonBlank,
  rowEvents,
  type EventOf,
} from '@seti/shared'

type Change = NonNullable<ToolCall['plan']>
type Report = NonNullable<EventOf<'tool.ended'>['result']['plan']>

const isStatus = (value: unknown): value is TodoStatus =>
  typeof value === 'string' && (TODO_STATUSES as readonly string[]).includes(value)

/**
 * The todo list an agent keeps with its runtime's plan tools, folded from its messages in id
 * order. A call counts once its result arrives without an error. A whole list a subagent writes
 * is that subagent's own, so only the agent's own counts; single items share one list per
 * session, so every call counts. A new session starts an empty list, as the runtime does.
 */
export class TodoIndex {
  lastId = 0
  private items: AgentTodo[] = []
  private session: string | null = null
  private readonly calls = new Map<string, Change>()

  /** Folds one message in; true when it changed the list. Older messages are ignored. */
  apply(row: MessageRow): boolean {
    if (row.id <= this.lastId) {
      return false
    }
    this.lastId = row.id
    const before = JSON.stringify(this.items)
    let restarted = false
    for (const event of rowEvents(row)) {
      if (event.type === 'session.started') {
        restarted = this.started(event.sessionId) || restarted
      } else if (event.type === 'tool.started') {
        this.noteCall(event)
      } else if (event.type === 'tool.ended') {
        this.ended(event)
      }
    }
    return restarted || JSON.stringify(this.items) !== before
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

  private noteCall({ call, thread }: EventOf<'tool.started'>): void {
    const change = call.plan
    if (change === undefined || change.proposal !== undefined) {
      return
    }
    if (change.replace !== undefined && thread !== '') {
      return
    }
    this.calls.set(call.callId, change)
  }

  private ended(event: EventOf<'tool.ended'>): void {
    const change = this.calls.get(event.callId)
    if (change === undefined) {
      return
    }
    this.calls.delete(event.callId)
    if (event.status !== 'error') {
      this.applyCall(change, event.result)
    }
  }

  private applyCall(change: Change, result: EventOf<'tool.ended'>['result']): void {
    const report = result.plan
    if (change.replace !== undefined) {
      this.items = change.replace.map((item) => ({
        id: item.id,
        content: item.text,
        active_form: item.activeText ?? null,
        status: item.status,
      }))
    } else if (change.add !== undefined) {
      this.created(change.add, result.planId)
    } else if (change.update !== undefined) {
      this.updated(change.update, report)
    } else if (report?.items !== undefined) {
      this.listed(report.items)
    } else if (report?.item !== undefined) {
      this.got(report.item)
    }
  }

  private created(add: NonNullable<Change['add']>, id: string | undefined): void {
    const content = nonBlank(add.text)
    if (id === undefined || content === null) {
      return
    }
    const todo: AgentTodo = { id, content, active_form: add.activeText ?? null, status: 'pending' }
    this.items = [...this.items.filter((item) => item.id !== id), todo]
  }

  private updated(update: NonNullable<Change['update']>, report: Report | undefined): void {
    const { id, status } = update
    if (id === '' || report?.unchanged === true) {
      return
    }
    if (status === 'deleted') {
      this.items = this.items.filter((item) => item.id !== id)
      return
    }
    this.items = this.items.map((item) =>
      item.id === id
        ? {
            ...item,
            content: update.text ?? item.content,
            active_form: update.activeText ?? item.active_form,
            status: isStatus(status) ? status : item.status,
          }
        : item,
    )
  }

  /** The whole list as the runtime reports it, which settles any call this index missed. */
  private listed(items: NonNullable<Report['items']>): void {
    const known = new Map(this.items.map((item) => [item.id, item]))
    this.items = items.map((item) => ({
      id: item.id,
      content: item.text,
      active_form: known.get(item.id)?.active_form ?? null,
      status: item.status,
    }))
  }

  private got(task: NonNullable<Report['item']>): void {
    this.items = this.items.map((item) =>
      item.id === task.id ? { ...item, content: task.text ?? item.content, status: task.status } : item,
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
