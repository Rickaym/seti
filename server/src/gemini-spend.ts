import { eventsOf, payloadEvents, type AcpRecord } from '@seti/shared'
import { callCost } from './runtimes/prices.js'
import { codexTurns } from './store/codex-turns.js'

/** The model the agent's latest Gemini session runs on, or null before one started. */
async function sessionModel(taskId: string): Promise<string | null> {
  const start = await codexTurns.sessionStart(taskId, 'gemini')
  return start === null ? null : (eventsOf(payloadEvents(start, 'gemini'), 'session.started').at(0)?.model ?? null)
}

type PromptUsage = NonNullable<Extract<AcpRecord, { seti: 'ended' }>['usage']>

/**
 * A Gemini turn's estimated cost at Google's rates on the day, or null for a model the table
 * lacks. Gemini CLI counts cached tokens inside its input and thought tokens apart from its
 * output, which Google bills as output. A turn's calls are priced together, so a model's
 * long-context line applies to the turn's input as a whole.
 */
export function geminiTurnCost(model: string, usage: PromptUsage, at = new Date()): number | null {
  const cached = usage.cachedReadTokens ?? 0
  const output = usage.outputTokens + (usage.thoughtTokens ?? 0)
  return callCost('google', model, { input: Math.max(0, usage.inputTokens - cached), cacheRead: cached, output }, at)
}

/** A Gemini turn's end with its estimated cost, read for the model its session runs on. */
export async function withGeminiCost(taskId: string, record: AcpRecord): Promise<AcpRecord> {
  if (record.seti !== 'ended' || record.usage === null) {
    return record
  }
  const model = await sessionModel(taskId)
  const usd = model === null ? null : geminiTurnCost(model, record.usage)
  return usd === null ? record : { ...record, usd }
}
