import { afterEach, describe, expect, it, vi } from 'vitest'
import { storedShowSetiFiles, storeShowSetiFiles } from '@/panels/files/seti-files'

const memory = () => {
  const items = new Map<string, string>()
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      items.set(key, value)
    },
  }
}

const blocked = {
  getItem: () => {
    throw new Error('blocked')
  },
  setItem: () => {
    throw new Error('blocked')
  },
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the Seti files choice', () => {
  it('hides Seti files until turned on, and remembers the choice', () => {
    vi.stubGlobal('localStorage', memory())
    expect(storedShowSetiFiles()).toBe(false)
    storeShowSetiFiles(true)
    expect(storedShowSetiFiles()).toBe(true)
    storeShowSetiFiles(false)
    expect(storedShowSetiFiles()).toBe(false)
  })

  it('keeps them hidden when storage is blocked', () => {
    vi.stubGlobal('localStorage', blocked)
    expect(() => {
      storeShowSetiFiles(true)
    }).not.toThrow()
    expect(storedShowSetiFiles()).toBe(false)
  })
})
