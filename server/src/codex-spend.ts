import { eventsOf, payloadEvents, type CodexMessage, type RuntimeEvent, type TurnSpend } from '@seti/shared'
import { callCost } from './runtimes/prices.js'
import { codexTurns } from './store/codex-turns.js'

const codexEvents = (payload: string) => payloadEvents(payload, 'codex')

/** The model the agent's latest session runs on, or null before one started. */
async function sessionModel(taskId: string): Promise<string | null> {
  const start = await codexTurns.sessionStart(taskId)
  return start === null ? null : (eventsOf(codexEvents(start), 'session.started').at(0)?.model ?? null)
}

/** The turn's tokens summed, and their estimated cost where every call has a price. */
function summed(usages: readonly Extract<RuntimeEvent, { type: 'usage' }>['usage'][], model: string | null): TurnSpend {
  const spent = { input: 0, output: 0, cacheRead: 0, reasoning: 0 }
  let cacheWrite: number | undefined
  let usd: number | null = 0
  for (const usage of usages) {
    spent.input += usage.input
    spent.output += usage.output
    spent.cacheRead += usage.cacheRead ?? 0
    spent.reasoning += usage.reasoning ?? 0
    cacheWrite = usage.cacheWrite === undefined ? cacheWrite : (cacheWrite ?? 0) + usage.cacheWrite
    const cost = model === null ? null : callCost('openai', model, usage)
    usd = usd === null || cost === null ? null : usd + cost
  }
  return { ...spent, ...(cacheWrite === undefined ? {} : { cacheWrite }), ...(usd === null ? {} : { usd }) }
}

/**
 * The message with what its turn spent, where it ends a turn of the agent's own thread: the
 * tokens of the turn's model calls and their cost estimated from OpenAI's public prices.
 */
export async function withSpend(
  taskId: string,
  m: CodexMessage,
  events: readonly RuntimeEvent[],
): Promise<CodexMessage> {
  if (!events.some((event) => event.type === 'turn.ended' && event.thread === '')) {
    return m
  }
  const usages = (await codexTurns.usage(taskId)).flatMap((payload) =>
    eventsOf(codexEvents(payload), 'usage').map((event) => event.usage),
  )
  return { ...m, spent: summed(usages, await sessionModel(taskId)) }
}
