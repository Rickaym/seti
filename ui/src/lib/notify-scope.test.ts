import type { NotifyScopeInput } from '@seti/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const apiPut = vi.fn()
const answer = (workspaceId: string) => ({ workspace_id: workspaceId, workspace_only: true })
vi.mock('@/api', () => ({ apiPut }))
vi.mock('@/lib/device', () => ({ deviceId: () => 'device-1' }))

describe('reportNeeded', () => {
  it('reports the first time a page asks, whatever the device reported before', async () => {
    const { reportNeeded } = await import('./notify-scope')
    expect(reportNeeded('a', { answered: false, sending: null, reported: 'a' })).toBe(true)
  })

  it('skips a workspace the device last reported or that is on its way', async () => {
    const { reportNeeded } = await import('./notify-scope')
    expect(reportNeeded('a', { answered: true, sending: null, reported: 'a' })).toBe(false)
    expect(reportNeeded('a', { answered: false, sending: 'a', reported: null })).toBe(false)
  })

  it('reports a workspace other than the one last reported, from this tab or another', async () => {
    const { reportNeeded } = await import('./notify-scope')
    expect(reportNeeded('b', { answered: true, sending: null, reported: 'a' })).toBe(true)
    expect(reportNeeded('b', { answered: true, sending: 'a', reported: 'a' })).toBe(true)
  })
})

describe('reportWorkspace', () => {
  let stored: Map<string, string>

  beforeEach(() => {
    stored = new Map()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
      removeItem: (key: string) => stored.delete(key),
    })
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    apiPut.mockReset()
  })

  const sent = () => apiPut.mock.calls.map(([, input]) => (input as NotifyScopeInput).workspace_id)

  it('sends one report per change and none for repeats', async () => {
    apiPut.mockResolvedValueOnce(answer('a')).mockResolvedValueOnce(answer('b'))
    const { reportWorkspace } = await import('./notify-scope')
    reportWorkspace('a')
    reportWorkspace('a')
    await vi.waitFor(() => {
      expect(stored.get('seti.notify.reported')).toBe('a')
    })
    reportWorkspace('a')
    reportWorkspace('b')
    await vi.waitFor(() => {
      expect(stored.get('seti.notify.reported')).toBe('b')
    })
    reportWorkspace('b')
    expect(sent()).toEqual(['a', 'b'])
    expect(apiPut).toHaveBeenCalledWith('/notifications/devices/device-1/scope', { workspace_id: 'a' })
  })

  it('reports again when another tab of the browser reported another workspace', async () => {
    apiPut.mockResolvedValue(answer('a'))
    const { reportWorkspace } = await import('./notify-scope')
    reportWorkspace('a')
    await vi.waitFor(() => {
      expect(stored.get('seti.notify.reported')).toBe('a')
    })
    stored.set('seti.notify.reported', 'b')
    reportWorkspace('a')
    expect(sent()).toEqual(['a', 'a'])
  })

  it('tries again after a report Seti did not take', async () => {
    apiPut.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(answer('a'))
    const { reportWorkspace } = await import('./notify-scope')
    reportWorkspace('a')
    await new Promise((resolve) => setTimeout(resolve, 0))
    reportWorkspace('a')
    await vi.waitFor(() => {
      expect(stored.get('seti.notify.reported')).toBe('a')
    })
    expect(sent()).toEqual(['a', 'a'])
  })
})
