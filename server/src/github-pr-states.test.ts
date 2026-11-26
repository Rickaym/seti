import { describe, expect, it, vi } from 'vitest'
import { prStates } from './github-pr-states.js'

const gh = vi.hoisted(() => ({ asked: [] as string[][] }))

const ANSWERS: Record<string, string> = { '1': 'MERGED', '2': 'CLOSED' }

vi.mock('./redis.js', async (importOriginal) => {
  const kept = new Map<string, unknown>()
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    cache: {
      getMany: async (keys: readonly string[]) => Promise.resolve(keys.map((key) => kept.get(key))),
      set: async (key: string, value: unknown) => {
        kept.set(key, value)
        return Promise.resolve()
      },
    },
  }
})

vi.mock('./github.js', () => ({
  fetchResources: async <T>(urls: readonly string[], _fields: string, parse: (node: unknown) => T) => {
    gh.asked.push([...urls])
    const node = (state: string) => ({
      title: `Title ${state}`,
      state,
      commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
    })
    const answer = (url: string) => {
      const state = ANSWERS[url.split('/').at(-1) ?? '']
      return state === undefined ? null : parse(node(state))
    }
    return Promise.resolve(new Map(urls.map((url) => [url, answer(url)])))
  },
}))

const url = (n: number) => `https://github.com/acme/states-${String(Date.now())}/pull/${String(n)}`

describe('the state of PRs a request names', () => {
  it('reads merged and closed PRs once, then from the cache, and leaves out what is no PR', async () => {
    const urls = [url(1), url(2), url(3)]
    const first = await prStates(urls)
    expect(first.get(urls[0] ?? '')).toEqual({ title: 'Title MERGED', state: 'merged', ci: null })
    expect(first.get(urls[1] ?? '')).toEqual({ title: 'Title CLOSED', state: 'closed', ci: null })
    expect(first.has(urls[2] ?? '')).toBe(false)

    const asked = gh.asked.length
    const again = await prStates(urls.slice(0, 2))
    expect(again.get(urls[0] ?? '')?.state).toBe('merged')
    expect(gh.asked).toHaveLength(asked)
  })
})
