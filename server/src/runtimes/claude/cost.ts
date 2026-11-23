import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'
import { TURN_COST_KEY, type ClaudeMessage, type WithTurnCost } from '@seti/shared'

/** The session and the running total of its cost that a result reports, in US dollars. */
export const sessionTotal = (m: ClaudeMessage): { sessionId: string; usd: number } | null =>
  m.type === 'result' ? { sessionId: m.session_id, usd: m.total_cost_usd } : null

/** The result with what its turn cost, which its `turn.ended` event then carries. */
export function withTurnCost(m: ClaudeMessage, usd: number): ClaudeMessage {
  if (m.type !== 'result') {
    return m
  }
  const counted: WithTurnCost<SDKResultMessage> = { ...m, [TURN_COST_KEY]: usd }
  return counted
}
