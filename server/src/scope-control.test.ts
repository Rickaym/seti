import type { NodeCommand } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { serveControl, type NodeEnd } from './node-link.js'
import { capCpuScopes, capMemoryScopes } from './scope-control.js'

const CAP = { high_mb: 1024, max_mb: 2048, swap_max_mb: 0 }

function node(): { capped: NodeCommand<'scopes.cap'>[] } {
  const capped: NodeCommand<'scopes.cap'>[] = []
  const refuse = () => {
    throw new Error('not in this test')
  }
  serveControl({
    'scopes.agents': () => ({ agents: ['a', 'b'] }),
    'scopes.cap': (body) => {
      capped.push(body)
      return {}
    },
    'scopes.read': refuse,
  } as Partial<NodeEnd> as NodeEnd)
  return { capped }
}

describe('scope caps on the node', () => {
  it('hands the node the caps of the agents with a live scope, leaving out those the change skips', async () => {
    const { capped } = node()
    await capMemoryScopes(async (agent) => Promise.resolve(agent === 'a' ? CAP : null))
    await capCpuScopes(async () => Promise.resolve({ quota_percent: 150 }))
    expect(capped).toEqual([
      { memory: [{ agent: 'a', cap: CAP }], cpu: [] },
      {
        memory: [],
        cpu: [
          { agent: 'a', cap: { quota_percent: 150 } },
          { agent: 'b', cap: { quota_percent: 150 } },
        ],
      },
    ])
  })
})
