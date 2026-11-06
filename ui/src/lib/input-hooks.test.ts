import { describe, expect, it } from 'vitest'
import { hookTakesEscape, hookTakesFindEnter, inputHooks } from './input-hooks'

const key = (name: string) => ({ key: name }) as KeyboardEvent

describe('input hooks', () => {
  it('take Esc and find Enter only while a hook that wants them is registered', () => {
    expect(hookTakesEscape(key('Escape'))).toBe(false)
    const field = {} as HTMLElement
    const dispose = inputHooks.register({
      key: 'test.keys',
      takesEscape: (e) => e.key === 'Escape',
      onFindEnter: (_field, e) => !e.shiftKey,
    })
    expect(hookTakesEscape(key('Escape'))).toBe(true)
    expect(hookTakesFindEnter(field, { shiftKey: false })).toBe(true)
    expect(hookTakesFindEnter(field, { shiftKey: true })).toBe(false)
    dispose()
    expect(hookTakesEscape(key('Escape'))).toBe(false)
    expect(hookTakesFindEnter(field, { shiftKey: false })).toBe(false)
  })
})
