import { describe, expect, it } from 'vitest'
import { hookTakesEscape, hookTakesFindEnter, hookTakesTerminalKey, inputHooks } from './input-hooks'

const key = (name: string) => ({ key: name }) as KeyboardEvent

describe('input hooks', () => {
  it('take Esc, find Enter and terminal keys only while a hook that wants them is registered', () => {
    expect(hookTakesEscape(key('Escape'))).toBe(false)
    expect(hookTakesTerminalKey(key('\\'))).toBe(false)
    const field = {} as HTMLElement
    const dispose = inputHooks.register({
      key: 'test.keys',
      takesEscape: (e) => e.key === 'Escape',
      takesTerminalKey: (e) => e.key === '\\',
      onFindEnter: (_field, e) => !e.shiftKey,
    })
    expect(hookTakesEscape(key('Escape'))).toBe(true)
    expect(hookTakesTerminalKey(key('\\'))).toBe(true)
    expect(hookTakesTerminalKey(key('x'))).toBe(false)
    expect(hookTakesFindEnter(field, { shiftKey: false })).toBe(true)
    expect(hookTakesFindEnter(field, { shiftKey: true })).toBe(false)
    dispose()
    expect(hookTakesEscape(key('Escape'))).toBe(false)
    expect(hookTakesTerminalKey(key('\\'))).toBe(false)
    expect(hookTakesFindEnter(field, { shiftKey: false })).toBe(false)
  })
})
