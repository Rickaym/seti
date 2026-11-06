import type { EaAsk, EaAskDecision, EaAskState } from '@seti/shared'
import { audit } from './audit.js'
import { now } from './db.js'
import { fromEa, refuseAgent } from './ea-guard.js'
import { HttpError } from './http.js'
import { eaAsks } from './store/ea-replies.js'

const STANDING: Record<EaAskState, string> = {
  pending: 'still open',
  expired: 'expired; ask the EA again',
  allowed: 'already allowed',
  denied: 'already denied',
  done: 'already allowed and done',
  failed: 'already allowed, and it failed',
}

/**
 * The user's Allow or Deny for one question the EA asked. Only the user answers: the EA and
 * agents are refused, and each question takes one answer while it is open.
 */
export async function decideAsk(id: number, decision: EaAskDecision): Promise<EaAsk> {
  if (fromEa()) {
    throw new HttpError(403, 'The EA cannot answer its own questions; the user does that in Seti')
  }
  refuseAgent("answer the EA's questions")
  const at = now()
  const result = await eaAsks.decide(id, decision, at)
  if (!result.ok) {
    if (result.state === null) {
      throw new HttpError(404, 'The EA asked no such question')
    }
    throw new HttpError(409, `That question is ${STANDING[result.state]}`)
  }
  const { ask } = result
  const allowed = decision === 'allow'
  await audit.record({
    actor: 'user',
    kind: allowed ? 'ea.ask_allowed' : 'ea.ask_denied',
    subject_type: 'ea',
    summary: `${allowed ? 'Allowed' : 'Denied'} the EA to ${ask.summary}`,
    detail: { ask: ask.id, tool: ask.tool },
  })
  const current = await eaAsks.get(ask.id, at)
  if (current === undefined) {
    throw new HttpError(404, 'The EA asked no such question')
  }
  return current
}
