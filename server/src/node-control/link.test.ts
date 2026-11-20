import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../app.js'
import { messages, tasks } from '../db.js'
import type { NodeServer } from '../node-link/transport.js'
import { inProcessDecisions } from '../session-decisions.js'
import { startNodeLink, type NodeLink } from '../session-host/node-link.js'
import { isRunning } from '../session-mirror.js'
import { ControlLink } from './link.js'
import { nodeCursors } from '../store/nodes.js'

/** Each turn says it works, waits until the test lets it go on, then says more and finishes. */
const sdk = await vi.hoisted(async () => {
  const { FakeSdk, fakeAssistant, fakeResult } = await import('../fake-sdk.js')
  const gates = new Map<string, () => void>()
  const fake = new FakeSdk(async function* ({ text }) {
    yield fakeAssistant(`working on: ${text}`)
    await new Promise<void>((resolve) => gates.set(text, resolve))
    for (let i = 1; i <= 5; i += 1) {
      yield fakeAssistant(`step ${String(i)} of: ${text}`)
    }
    yield fakeResult()
  })
  return { fake, gates }
})

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  query: sdk.fake.query,
}))

createApp()

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'seti-node-link-'))
const socket = path.join(dir, 'node.sock')
let control = new ControlLink()
let server: NodeServer = await control.listen(socket)
const node: NodeLink = await startNodeLink({
  socket,
  journalDir: path.join(dir, 'journal'),
  node: 'local',
  decisions: () => inProcessDecisions,
})

afterAll(async () => {
  for (const taskId of node.host.views().keys()) {
    await node.host.end(taskId)
  }
  await node.dialer.stop()
  await server.close()
  await node.journal.close()
  await fs.rm(dir, { recursive: true, force: true })
})

async function newTask(id: string): Promise<string> {
  await tasks.insert({ id, title: id, repo_id: null, cwd: '/tmp', worktree: false, sandbox: false, pr_urls: [] })
  return id
}

/** The transcript's texts in order: prompts, then what the agent said. */
async function said(taskId: string): Promise<string[]> {
  const page = await messages.page(taskId, 200)
  return page.messages.flatMap((row) => {
    if (row.kind === 'prompt') {
      return [`prompt: ${row.payload.text}`]
    }
    if (row.kind === 'sdk' && row.payload.type === 'assistant') {
      const [block] = row.payload.message.content
      return typeof block === 'object' && block.type === 'text' ? [block.text] : []
    }
    return row.kind === 'sdk' && row.payload.type === 'result' ? ['result'] : []
  })
}

const expected = (text: string) => [
  `prompt: ${text}`,
  `working on: ${text}`,
  ...[1, 2, 3, 4, 5].map((i) => `step ${String(i)} of: ${text}`),
  'result',
]

async function finished(taskId: string): Promise<void> {
  await vi.waitFor(async () => {
    expect((await tasks.get(taskId))?.status).toBe('idle')
    expect(isRunning(taskId)).toBe(false)
  })
}

describe('a session on the node', () => {
  it('runs a turn whose transcript and status the records side stores', async () => {
    await vi.waitFor(() => {
      expect(control.connected).toBe(true)
    })
    const taskId = await newTask('node-link-plain')
    await control.commands.start(taskId, { prompt: 'plain work' }, false, null)
    expect(isRunning(taskId)).toBe(true)
    expect((await tasks.get(taskId))?.status).toBe('running')
    await vi.waitFor(() => {
      expect(sdk.gates.has('plain work')).toBe(true)
    })
    sdk.gates.get('plain work')?.()
    await finished(taskId)
    expect(await said(taskId)).toEqual(expected('plain work'))
    expect((await nodeCursors.get(taskId))?.seq).toBeGreaterThan(0)
  })

  it('keeps the turn running while the records side restarts, and stores it once, in order', async () => {
    const taskId = await newTask('node-link-restart')
    await control.commands.start(taskId, { prompt: 'long work' }, false, null)
    await vi.waitFor(() => {
      expect(sdk.gates.has('long work')).toBe(true)
    })
    await server.close()
    control = new ControlLink()
    sdk.gates.get('long work')?.()
    await vi.waitFor(async () => {
      expect((await node.journal.agent(taskId)).lastSeq).toBeGreaterThan((await nodeCursors.get(taskId))?.seq ?? 0)
    })
    server = await control.listen(socket)
    await finished(taskId)
    expect(await said(taskId)).toEqual(expected('long work'))
  })
})
