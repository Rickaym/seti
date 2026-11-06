import { describe, expect, it } from 'vitest'
import { reviewThreads, unresolvedThreads } from './github-threads.js'

const threads = (...resolved: boolean[]) =>
  reviewThreads.parse({ nodes: resolved.map((isResolved) => ({ isResolved, isOutdated: false })) })

describe('unresolvedThreads', () => {
  it('counts the threads not yet resolved', () => {
    expect(unresolvedThreads(threads(false, true, false, true))).toBe(2)
  })

  it('is zero without threads or when every thread is resolved', () => {
    expect(unresolvedThreads(threads())).toBe(0)
    expect(unresolvedThreads(threads(true, true))).toBe(0)
  })

  it('counts an outdated thread while it stays unresolved', () => {
    const outdated = reviewThreads.parse({ nodes: [{ isResolved: false, isOutdated: true }] })
    expect(unresolvedThreads(outdated)).toBe(1)
  })

  it('rejects a thread without its resolved state', () => {
    expect(() => reviewThreads.parse({ nodes: [{ isOutdated: true }] })).toThrow()
  })
})
