import type { ModInfo, ModList } from '@seti/shared'
import { describe, expect, it, vi } from 'vitest'
import { moveLegacyChoices } from './legacy-choices'

const listWith = (enabled: boolean): ModList => ({
  mods: [{ id: 'vim', enabled } as ModInfo],
  safe_mode: false,
  safe_mode_forced: false,
  dev_mode: false,
  bisect: null,
  unisolated: false,
})

const storeWith = (value: string | null) => {
  const values = new Map<string, string>(value === null ? [] : [['seti-ui-vim', value]])
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => {
      values.delete(key)
    },
  }
}

describe('moveLegacyChoices', () => {
  it('turns Vim mode on once for a browser that had it on, then forgets the old key', async () => {
    const store = storeWith('on')
    const enable = vi.fn(async () => Promise.resolve())
    expect(await moveLegacyChoices(listWith(false), enable, store)).toBe(true)
    expect(enable).toHaveBeenCalledWith('vim')
    expect(store.values.size).toBe(0)
    expect(await moveLegacyChoices(listWith(true), enable, store)).toBe(false)
    expect(enable).toHaveBeenCalledTimes(1)
  })

  it('only forgets the key when the browser had it off or the mod is on already', async () => {
    const enable = vi.fn(async () => Promise.resolve())
    for (const [choice, enabled] of [
      ['off', false],
      ['on', true],
    ] as const) {
      const store = storeWith(choice)
      expect(await moveLegacyChoices(listWith(enabled), enable, store)).toBe(false)
      expect(store.values.size).toBe(0)
    }
    expect(enable).not.toHaveBeenCalled()
  })

  it('keeps the key when turning the mod on fails, so the next load tries again', async () => {
    const store = storeWith('on')
    await expect(
      moveLegacyChoices(listWith(false), async () => Promise.reject(new Error('down')), store),
    ).rejects.toThrow('down')
    expect(store.values.get('seti-ui-vim')).toBe('on')
  })
})
