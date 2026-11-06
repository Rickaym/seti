import { TURN_COST_KEY } from '@seti/shared'

/** Builds the transcript rows Seti stores, with stable ids so every run seeds the same data. */
export type Row = [kind: string, payload: unknown]

export class Transcript {
  readonly rows: Row[] = []
  private count = 0

  private readonly session: string

  constructor(session: string) {
    this.session = session
  }

  private id(): string {
    this.count += 1
    return `${this.session}-${String(this.count).padStart(4, '0')}`
  }

  private sdk(payload: Record<string, unknown>): this {
    this.rows.push(['sdk', { session_id: this.session, uuid: this.id(), ...payload }])
    return this
  }

  private assistant(content: unknown[], parent: string | null): this {
    const message = { id: this.id(), type: 'message', role: 'assistant', model: 'claude-opus', content }
    return this.sdk({ type: 'assistant', parent_tool_use_id: parent, message })
  }

  prompt(text: string): this {
    this.rows.push(['prompt', { text }])
    return this
  }

  say(text: string, parent: string | null = null): this {
    return this.assistant([{ type: 'text', text }], parent)
  }

  /** A tool call and, unless `output` is null, its result, which stays pending otherwise. */
  tool(name: string, input: Record<string, unknown>, output: string | null, parent: string | null = null): this {
    const id = `toolu_${this.id()}`
    this.assistant([{ type: 'tool_use', id, name, input }], parent)
    if (output === null) {
      return this
    }
    return this.sdk({
      type: 'user',
      parent_tool_use_id: parent,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: output }] },
    })
  }

  bash(command: string, output: string | null, description?: string, parent: string | null = null): this {
    return this.tool('Bash', { command, ...(description === undefined ? {} : { description }) }, output, parent)
  }

  /** Starts a background subagent under `id`, which has made `uses` tool calls so far. */
  subagent(id: string, description: string, uses: number): this {
    const prompt = `${description}. Report what you find.`
    const input = { description, subagent_type: 'general-purpose', prompt, run_in_background: true }
    this.assistant([{ type: 'tool_use', id, name: 'Agent', input }], null)
    this.sdk({
      type: 'system',
      subtype: 'task_started',
      task_id: `a_${id}`,
      tool_use_id: id,
      description,
      subagent_type: 'general-purpose',
      is_backgrounded: true,
      spawn_depth: 1,
      task_type: 'local_agent',
    })
    const launched = `Async agent launched successfully.\nagentId: a_${id} (internal ID)`
    this.sdk({
      type: 'user',
      parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: launched }] },
      tool_use_result: { isAsync: true, status: 'async_launched', agentId: `a_${id}`, description, prompt },
    })
    return this.sdk({
      type: 'system',
      subtype: 'task_progress',
      task_id: `a_${id}`,
      tool_use_id: id,
      description: 'progress',
      usage: { total_tokens: uses * 3900, tool_uses: uses, duration_ms: uses * 4200 },
      last_tool_name: 'Grep',
    })
  }

  /** Ends the background subagent under `id` with its report. */
  reported(id: string, uses: number, report: string): this {
    return this.sdk({
      type: 'system',
      subtype: 'task_notification',
      task_id: `a_${id}`,
      tool_use_id: id,
      status: 'completed',
      output_file: '',
      summary: report,
      usage: { total_tokens: uses * 3900, tool_uses: uses, duration_ms: uses * 4200 },
    })
  }

  todos(items: readonly [content: string, status: 'completed' | 'in_progress' | 'pending'][]): this {
    const todos = items.map(([content, status]) => ({ content, status, activeForm: content }))
    return this.tool('TodoWrite', { todos }, 'Todos have been modified successfully.')
  }

  /** A turn's end as Seti stores it, with what that turn alone cost. */
  ended(ms: number, cost: number): this {
    return this.sdk({
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: ms,
      num_turns: 1,
      result: 'done',
      total_cost_usd: cost,
      [TURN_COST_KEY]: cost,
    })
  }

  done(turns: number, cost: number): this {
    return this.sdk({
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: turns * 21_000,
      num_turns: turns,
      result: 'done',
      total_cost_usd: cost,
    })
  }
}
