import { defaultMemoryCap } from '@seti/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentHeapFlag, agentHeapMb, memoryEnv, withAgentHeap } from './node-heap.js'
import { agentEnv } from './session-realise.js'

const SIX_GB = defaultMemoryCap(8192)

const UNCAPPED = '--max-old-space-size=6144'

describe('withAgentHeap', () => {
  it('sets the heap size when nothing else is set', () => {
    expect(withAgentHeap(undefined, null)).toBe(UNCAPPED)
    expect(withAgentHeap('  ', null)).toBe(UNCAPPED)
  })

  it('appends to existing options', () => {
    expect(withAgentHeap('--enable-source-maps', null)).toBe(`--enable-source-maps ${UNCAPPED}`)
  })

  it('keeps a heap size that is already set', () => {
    expect(withAgentHeap(UNCAPPED, SIX_GB)).toBe(UNCAPPED)
    expect(withAgentHeap('--max-old-space-size=2048 --trace-warnings', null)).toBe(
      '--max-old-space-size=2048 --trace-warnings',
    )
    expect(withAgentHeap('--max_old_space_size 4096', null)).toBe('--max_old_space_size 4096')
  })

  it('does not mistake a longer flag for the heap size', () => {
    expect(withAgentHeap('--max-old-space-size-percentage=50', null)).toBe(
      `--max-old-space-size-percentage=50 ${UNCAPPED}`,
    )
  })
})

describe('the default memory cap', () => {
  const maxOf = (hostGb: number) => defaultMemoryCap(hostGb * 1024).max_mb

  it('is 30% of the host in whole GB, at least 6 GB and at most 16 GB', () => {
    expect([8, 16, 32, 128].map(maxOf)).toEqual([6144, 6144, 10240, 16384])
    expect(maxOf(30.5)).toBe(9216)
    expect(maxOf(64)).toBe(16384)
  })

  it('has no throttle point, keeps 1 GB of swap and scales the Node heap with it', () => {
    expect(defaultMemoryCap(32 * 1024)).toEqual({ high_mb: 10240, max_mb: 10240, swap_max_mb: 1024 })
    expect([8, 32, 128].map((gb) => agentHeapMb(defaultMemoryCap(gb * 1024)))).toEqual([4300, 7168, 11468])
  })
})

describe('the heap under a memory cap', () => {
  it('leaves Node tools 70% of the cap, and the old default without one', () => {
    expect(agentHeapMb(SIX_GB)).toBe(4300)
    expect(agentHeapFlag({ high_mb: 1024, max_mb: 1024, swap_max_mb: 0 })).toBe('--max-old-space-size=716')
    expect(agentHeapMb(null)).toBe(6144)
  })

  it('tells the process tree its cap only when one holds it', () => {
    expect(memoryEnv(undefined, SIX_GB)).toEqual({
      NODE_OPTIONS: '--max-old-space-size=4300',
      SETI_MEMORY_CAP_MB: '6144',
    })
    expect(memoryEnv(undefined, null)).toEqual({ NODE_OPTIONS: UNCAPPED })
  })
})

describe('agentEnv', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('gives an unsandboxed agent the heap size of its cap', () => {
    vi.stubEnv('NODE_OPTIONS', undefined)
    expect(agentEnv(null).NODE_OPTIONS).toBe(UNCAPPED)
    expect(agentEnv(SIX_GB)).toMatchObject({
      NODE_OPTIONS: '--max-old-space-size=4300',
      SETI_MEMORY_CAP_MB: '6144',
    })
  })

  it("keeps the server's own NODE_OPTIONS and appends the heap size once", () => {
    vi.stubEnv('NODE_OPTIONS', '--enable-source-maps')
    const first = agentEnv(null).NODE_OPTIONS
    expect(first).toBe(`--enable-source-maps ${UNCAPPED}`)
    vi.stubEnv('NODE_OPTIONS', first)
    expect(agentEnv(null).NODE_OPTIONS).toBe(first)
  })
})
