import { describe, expect, it } from 'vitest'
import { eaHistory, eaSettings } from './store/ea.js'

describe('EA store', () => {
  it('starts with an empty history and the default settings', async () => {
    expect(await eaHistory.page(10)).toEqual({ entries: [], has_older: false })
    expect((await eaSettings.get()).wake_enabled).toBe(false)
  })

  it('keeps ids growing after a clear, so a summary never covers new entries', async () => {
    const [first] = await eaHistory.append({ entries: [{ kind: 'message', message: { role: 'user', content: 'a' } }] })
    await eaHistory.clear()
    const [second] = await eaHistory.append({
      entries: [{ kind: 'message', message: { role: 'user', content: 'b' } }],
    })
    expect(second).toBeGreaterThan(first ?? Infinity)
  })
})
