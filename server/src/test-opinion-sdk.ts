import { fakeAssistant, fakeMessage, FakeSdk } from './fake-sdk.js'

/** What the fake Claude Code answers every second opinion with. */
export const CLAUDE_OPINION = 'Claude says: evict() takes the cache lock while the queue lock is held.'

/** A fake Claude Code whose every session gives the same opinion and its cost. */
export const opinionSdk = (): FakeSdk =>
  new FakeSdk(function* () {
    yield fakeAssistant(CLAUDE_OPINION)
    yield fakeMessage('result', {
      subtype: 'success',
      is_error: false,
      result: CLAUDE_OPINION,
      errors: [],
      total_cost_usd: 0.002,
      duration_ms: 1,
      num_turns: 1,
    })
  })
