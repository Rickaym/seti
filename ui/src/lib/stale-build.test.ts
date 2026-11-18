import { describe, expect, it } from 'vitest'
import { claimReload, isStaleBuildError, planRecovery, RELOAD_WINDOW_MS } from './stale-build'

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const items = new Map<string, string>()
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value)
    },
  }
}

const NOW = Date.parse('2026-11-17T10:00:00Z')
const LATER = NOW + RELOAD_WINDOW_MS + 1

describe('isStaleBuildError', () => {
  it.each([
    'Failed to fetch dynamically imported module: https://seti.example/assets/HomePanel-53dW7oFK.js',
    'error loading dynamically imported module: https://seti.example/assets/HomePanel-53dW7oFK.js',
    'Importing a module script failed.',
    'Unable to preload CSS for /assets/HomePanel-a1b2c3d4.css',
  ])('reads %s as a build file that did not load', (message) => {
    expect(isStaleBuildError(new TypeError(message))).toBe(true)
  })

  it('leaves other crashes alone', () => {
    expect(isStaleBuildError(new TypeError("Cannot read properties of null (reading 'kind')"))).toBe(false)
    expect(isStaleBuildError('Failed to fetch dynamically imported module')).toBe(false)
  })
})

describe('claimReload', () => {
  it('grants one reload per build', () => {
    const storage = memoryStorage()
    expect(claimReload(storage, 'index-a.js', NOW)).toBe(true)
    expect(claimReload(storage, 'index-a.js', NOW + 1)).toBe(false)
    expect(claimReload(storage, 'index-a.js', LATER)).toBe(false)
  })

  it('refuses a new build that fails right after the reload, and grants it once the window passed', () => {
    const storage = memoryStorage()
    expect(claimReload(storage, 'index-a.js', NOW)).toBe(true)
    expect(claimReload(storage, 'index-b.js', NOW + RELOAD_WINDOW_MS - 1)).toBe(false)
    expect(claimReload(storage, 'index-b.js', LATER)).toBe(true)
    expect(claimReload(storage, 'index-b.js', LATER + RELOAD_WINDOW_MS + 1)).toBe(false)
  })

  it('refuses when the reload cannot be recorded', () => {
    expect(claimReload(null, 'index-a.js', NOW)).toBe(false)
    const full = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException('full', 'QuotaExceededError')
      },
    }
    expect(claimReload(full, 'index-a.js', NOW)).toBe(false)
  })

  it('treats a record it cannot read as no record', () => {
    const blocked = {
      getItem: () => {
        throw new DOMException('blocked', 'SecurityError')
      },
      setItem: () => undefined,
    }
    expect(claimReload(blocked, 'index-a.js', NOW)).toBe(true)
    const garbled = memoryStorage()
    garbled.setItem('seti.stale-build.reloaded', '{"build":7}')
    expect(claimReload(garbled, 'index-a.js', NOW)).toBe(true)
  })
})

describe('planRecovery', () => {
  const input = (over: Partial<Parameters<typeof planRecovery>[0]> = {}) => ({
    storage: memoryStorage(),
    build: 'index-a.js',
    now: NOW,
    unsaved: false,
    reachable: async () => Promise.resolve(true),
    ...over,
  })

  it('reloads once, then leaves the reload to the user', async () => {
    const storage = memoryStorage()
    expect(await planRecovery(input({ storage }))).toBe('reload')
    expect(await planRecovery(input({ storage, now: NOW + 5 }))).toBe('manual')
  })

  it('offers the new version instead of reloading over unsaved changes, and keeps the reload', async () => {
    const storage = memoryStorage()
    expect(await planRecovery(input({ storage, unsaved: true }))).toBe('notice')
    expect(await planRecovery(input({ storage }))).toBe('reload')
  })

  it('does not reload while the server gives no answer, and keeps the reload', async () => {
    const storage = memoryStorage()
    const down = async () => Promise.resolve(false)
    expect(await planRecovery(input({ storage, reachable: down }))).toBe('manual')
    expect(await planRecovery(input({ storage, reachable: down, unsaved: true }))).toBe('manual')
    expect(await planRecovery(input({ storage }))).toBe('reload')
  })
})
