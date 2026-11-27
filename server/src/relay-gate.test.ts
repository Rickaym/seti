import type { ToolCall } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { gatedServers, type RelayDecide } from './relay-gate.js'
import type { RelayedServer } from './tool-relay.js'

/** A server that notes every call that reached it. */
function server(ran: { tool: string; args: Record<string, unknown> }[]): RelayedServer {
  return {
    name: 'seti',
    tools: [],
    call: async (tool, args) => {
      ran.push({ tool, args })
      return Promise.resolve({ content: [{ type: 'text', text: 'ran' }] })
    },
  }
}

const ARGS = { channel: 'general', text: 'deploy done', nested: { list: [1, 2] } }

describe("Seti's decision in the relay", () => {
  it('decides each call on the exact arguments the relay received, before the server sees it', async () => {
    const ran: { tool: string; args: Record<string, unknown> }[] = []
    const decided: ToolCall[] = []
    const release = { now: (allow: boolean) => allow }
    const decide: RelayDecide = async (call) => {
      decided.push(call)
      expect(ran).toEqual([])
      return new Promise((resolve) => {
        release.now = (allow) => {
          resolve(allow ? { allow } : { allow, message: 'no' })
          return allow
        }
      })
    }
    const [gated] = gatedServers([server(ran)], decide)
    const pending = gated?.call('post_message', ARGS, new AbortController().signal)
    await Promise.resolve()
    expect(decided).toEqual([
      {
        callId: 'relay-1',
        kind: 'mcp',
        name: 'mcp__seti__post_message',
        input: ARGS,
        mcp: { server: 'seti', tool: 'post_message' },
      },
    ])
    expect(ran).toEqual([])
    release.now(true)
    expect(await pending).toEqual({ content: [{ type: 'text', text: 'ran' }] })
    expect(ran).toEqual([{ tool: 'post_message', args: ARGS }])
  })

  it('never runs a call Seti refused, could not decide, or that was cancelled while it decided', async () => {
    const ran: { tool: string; args: Record<string, unknown> }[] = []
    const verdicts: RelayDecide[] = [
      async () => Promise.resolve({ allow: false, message: 'A rule of yours refuses posting.' }),
      async () => Promise.reject(new Error('the control plane is gone')),
    ]
    for (const decide of verdicts) {
      const [gated] = gatedServers([server(ran)], decide)
      expect(await gated?.call('post_message', ARGS, new AbortController().signal)).toMatchObject({ isError: true })
    }
    const cancel = new AbortController()
    const [gated] = gatedServers([server(ran)], async () => {
      cancel.abort()
      return Promise.resolve({ allow: true })
    })
    expect(await gated?.call('post_message', ARGS, cancel.signal)).toMatchObject({ isError: true })
    expect(ran).toEqual([])
  })

  it("tells the agent Seti's reason when it refuses", async () => {
    const [gated] = gatedServers([server([])], async () =>
      Promise.resolve({ allow: false, message: 'A rule of yours refuses posting.' }),
    )
    expect(await gated?.call('post_message', ARGS, new AbortController().signal)).toEqual({
      content: [{ type: 'text', text: 'A rule of yours refuses posting.' }],
      isError: true,
    })
  })
})
