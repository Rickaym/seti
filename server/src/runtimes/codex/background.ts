import type { CodexJob } from '@seti/shared'
import { z } from 'zod'
import type { CodexCall, CodexRpc } from './rpc.js'

const commandNote = z.looseObject({
  threadId: z.string().optional(),
  item: z.looseObject({ type: z.literal('commandExecution'), id: z.string() }),
})

const listed = z.looseObject({
  data: z.array(z.looseObject({ itemId: z.string(), processId: z.string() })),
})

/**
 * The agent's commands that outlive their turn. Codex says nothing when a command moves to the
 * background; a command still running at its turn's end is one, and Codex lists its process.
 */
export class Background {
  private readonly running = new Set<string>()
  private readonly jobs = new Map<string, CodexJob>()
  private readonly abandoned = new Set<string>()
  private readonly rpc: CodexRpc
  private readonly root: () => string

  constructor(rpc: CodexRpc, root: () => string) {
    this.rpc = rpc
    this.root = root
  }

  /** Follows the agent's commands; returns the job whose end this message reports, if any. */
  note(message: CodexCall): CodexJob | undefined {
    const note = commandNote.safeParse(message.params).data
    if (note === undefined || (note.threadId !== undefined && note.threadId !== this.root())) {
      return undefined
    }
    const { id } = note.item
    if (message.method === 'item/started') {
      this.running.add(id)
    } else if (message.method === 'item/completed') {
      this.running.delete(id)
      const job = this.jobs.get(id)
      this.jobs.delete(id)
      return job
    }
    return undefined
  }

  /** The commands of a turn being interrupted: they are never jobs; `stopAbandoned` ends them. */
  abandon(): void {
    for (const id of this.running) {
      if (!this.jobs.has(id)) {
        this.abandoned.add(id)
      }
    }
  }

  /** Stops what an interrupted turn left running, since Codex's interrupt leaves it running. */
  async stopAbandoned(): Promise<void> {
    if (this.abandoned.size === 0) {
      return
    }
    const threadId = this.root()
    const reply = listed.parse(await this.rpc.request('thread/backgroundTerminals/list', { threadId }))
    const stale = reply.data.filter((terminal) => this.abandoned.has(terminal.itemId))
    this.abandoned.clear()
    await Promise.all(
      stale.map(async (terminal) =>
        this.rpc.request('thread/backgroundTerminals/terminate', { threadId, processId: terminal.processId }),
      ),
    )
  }

  /** At a turn's end: the list request and Codex's reply naming the commands still running. */
  async listed(): Promise<{ message: CodexCall; reply: unknown } | null> {
    const fresh = [...this.running].filter((id) => !this.jobs.has(id) && !this.abandoned.has(id))
    if (fresh.length === 0) {
      return null
    }
    const params = { threadId: this.root() }
    const reply = listed.parse(await this.rpc.request('thread/backgroundTerminals/list', params))
    const data = reply.data.filter((terminal) => fresh.includes(terminal.itemId))
    for (const terminal of data) {
      this.jobs.set(terminal.itemId, { id: terminal.processId })
    }
    return data.length === 0
      ? null
      : { message: { method: 'thread/backgroundTerminals/list', params }, reply: { data } }
  }

  /** Asks Codex to stop a background command; its end then reports it stopped. */
  async stop(jobId: string): Promise<void> {
    const job = [...this.jobs.values()].find((each) => each.id === jobId)
    if (job === undefined) {
      throw new Error(`No background command ${jobId} is running`)
    }
    job.stopped = true
    await this.rpc.request('thread/backgroundTerminals/terminate', { threadId: this.root(), processId: jobId })
  }
}
