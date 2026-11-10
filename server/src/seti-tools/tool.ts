import type { Task } from '@seti/shared'
import { z } from 'zod'
import { HttpError } from '../http.js'

/** The agent that called a seti tool; tools act on Seti on its behalf. */
export interface ToolContext {
  caller: Task
  /** Aborts when Claude Code cancels the call or the session closes; tools that wait end then. */
  signal?: AbortSignal
}

/** One seti tool: its name and description as the agent sees them, its input and what it does. */
interface ToolSpec<S extends z.ZodRawShape> {
  name: string
  description: string
  input: S
  run: (args: z.output<z.ZodObject<S>>, ctx: ToolContext) => Promise<unknown>
}

/** A tool of the catalog with its input checked at the call, whatever its shape. */
export interface SetiTool {
  name: string
  description: string
  input: z.ZodRawShape
  call: (args: unknown, ctx: ToolContext) => Promise<unknown>
}

export function setiTool<S extends z.ZodRawShape>(spec: ToolSpec<S>): SetiTool {
  const schema = z.object(spec.input)
  return {
    name: spec.name,
    description: spec.description,
    input: spec.input,
    call: async (args, ctx) => spec.run(schema.parse(args ?? {}), ctx),
  }
}

/** A seti tool that cannot go ahead; the message tells the agent why. */
export class ToolRefusal extends HttpError {
  constructor(message: string) {
    super(409, message)
  }
}

/** Refuses an action on the calling agent itself, such as stopping or archiving it. */
export function notSelf(ctx: ToolContext, task: Pick<Task, 'id'>, what: string): void {
  if (task.id === ctx.caller.id) {
    throw new ToolRefusal(`You cannot ${what} yourself with a seti tool; the user does that in Seti.`)
  }
}

/** What a tool answers when it changed something and has nothing more to show. */
export const done = (text: string) => ({ ok: true, text })
