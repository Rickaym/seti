import { disposeAll, Registry } from '@seti/shared'
import { describe, expect, it } from 'vitest'

describe('a contribution registry', () => {
  it('takes each key once, keeps order, tells listeners and removes exactly what it added', () => {
    const registry = new Registry<{ id: string; n: number }>('thing', (entry) => entry.id)
    const heard: number[] = []
    registry.subscribe(() => heard.push(registry.list().length))
    const first = { id: 'a', n: 1 }
    const disposeA = registry.register(first)
    const disposeB = registry.register({ id: 'b', n: 2 })
    expect(() => registry.register({ id: 'a', n: 3 })).toThrow('The thing a is already registered')
    expect(registry.list().map((entry) => entry.n)).toEqual([1, 2])
    const snapshot = registry.list()
    expect(registry.list()).toBe(snapshot)
    disposeA()
    disposeA()
    expect(registry.get('a')).toBeUndefined()
    const again = registry.register({ id: 'a', n: 4 })
    disposeA()
    expect(registry.get('a')?.n).toBe(4)
    expect(
      disposeAll([
        again,
        disposeB,
        () => {
          throw new Error('boom')
        },
      ]).map((e) => e.message),
    ).toEqual(['boom'])
    expect(registry.list()).toEqual([])
    expect(heard).toEqual([1, 2, 1, 2, 1, 0])
  })
})
