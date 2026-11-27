import { describe, expect, it } from 'vitest'
import { isBehind, retryDelay, updateMoment, workerScript, type PageActivity } from '@/lib/app-build'

const IDLE: PageActivity = {
  hidden: false,
  typing: false,
  draft: false,
  unkeptText: false,
  dialog: false,
  uploading: false,
  unsaved: false,
  call: false,
}

describe('isBehind', () => {
  it('is behind when the server hands out another build', () => {
    expect(isBehind('aaaa1111', 'bbbb2222')).toBe(true)
  })

  it('is current on the same build, and never decides without both ids', () => {
    expect(isBehind('aaaa1111', 'aaaa1111')).toBe(false)
    expect(isBehind('', 'bbbb2222')).toBe(false)
    expect(isBehind('aaaa1111', null)).toBe(false)
    expect(isBehind('aaaa1111', undefined)).toBe(false)
    expect(isBehind('aaaa1111', '')).toBe(false)
  })
})

describe('updateMoment', () => {
  it('reloads an idle page at once', () => {
    expect(updateMoment(IDLE)).toBe('now')
  })

  it('waits while the user types, holds a draft or has a dialog open', () => {
    expect(updateMoment({ ...IDLE, typing: true })).toBe('wait')
    expect(updateMoment({ ...IDLE, draft: true })).toBe('wait')
    expect(updateMoment({ ...IDLE, dialog: true })).toBe('wait')
  })

  it('reloads a hidden page even with a kept draft or an open dialog', () => {
    expect(updateMoment({ ...IDLE, hidden: true, draft: true, dialog: true, typing: true })).toBe('now')
  })

  it('never reloads over an upload, unsaved changes, text a reload would lose or a live call', () => {
    for (const busy of [{ uploading: true }, { unsaved: true }, { unkeptText: true }, { call: true }]) {
      expect(updateMoment({ ...IDLE, hidden: true, ...busy })).toBe('wait')
      expect(updateMoment({ ...IDLE, ...busy })).toBe('wait')
    }
  })
})

describe('retryDelay', () => {
  it('starts at five seconds, doubles and stops at five minutes', () => {
    expect([1, 2, 3, 4].map(retryDelay)).toEqual([5_000, 10_000, 20_000, 40_000])
    expect(retryDelay(20)).toBe(300_000)
  })
})

describe('workerScript', () => {
  it('gives each build its own worker address, and development the plain one', () => {
    expect(workerScript('aaaa1111')).toBe('/sw.js?build=aaaa1111')
    expect(workerScript('')).toBe('/sw.js')
  })
})
