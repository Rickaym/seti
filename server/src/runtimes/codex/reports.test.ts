import { describe, expect, it } from 'vitest'
import { codexReport } from './reports.js'

const ROOT = 'thread-root'

describe('a Codex message as the session reports it', () => {
  it("marks the agent at work only for the agent's own turns and items", () => {
    const said = { threadId: ROOT, turnId: 't', item: { type: 'agentMessage', id: 'm', text: 'hi' } }
    const own = codexReport(ROOT, { method: 'item/completed', params: said })
    expect([own.work, own.byAgent]).toEqual([true, true])
    const child = codexReport(ROOT, { method: 'item/completed', params: { ...said, threadId: 'thread-child' } })
    expect([child.work, child.byAgent]).toEqual([true, false])
  })

  it('reports news about the session, such as a usage replay after a resume, as no work', () => {
    const usage = {
      threadId: ROOT,
      turnId: 'earlier',
      tokenUsage: {
        total: { totalTokens: 3, inputTokens: 2, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0 },
        last: { totalTokens: 3, inputTokens: 2, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0 },
      },
    }
    for (const message of [
      { method: 'thread/tokenUsage/updated', params: usage },
      { method: 'mcpServer/startupStatus/updated', params: { threadId: ROOT, name: 'seti', status: 'ready' } },
    ]) {
      const report = codexReport(ROOT, message)
      expect([report.work, report.byAgent]).toEqual([false, false])
    }
  })
})
