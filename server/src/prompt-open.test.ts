import { randomUUID } from 'node:crypto'
import type { AskFrame } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { messages, tasks } from './db.js'
import { AskLedger } from './node-inbox.js'
import { nodeLink } from './node-link.js'
import './runner.js'

let count = 0

async function runningTask(): Promise<string> {
  count += 1
  const id = `prompt-open-${String(count)}`
  await tasks.insert({ id, title: `Prompt ${String(count)}`, repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })
  await tasks.setStatus(id, 'running', null)
  return id
}

/** A control plane that answers the node's asks, until it crashes. */
const controlPlane = () => new AskLedger(async (frame, signal) => nodeLink.answer(frame, signal))

const promptRows = async (taskId: string) =>
  (await messages.page(taskId, 50)).messages.filter((row) => row.kind === 'prompt')

function openAsk(agent: string, prompt: string): AskFrame {
  const next = { prompt, interrupted: false }
  return { type: 'ask', id: randomUUID(), agent, ask: 'prompt.open', body: { next, queued: false } }
}

describe('the prompt row of a message a node sends', () => {
  it('is recorded once when the control plane crashes after answering and before the reply goes out', async () => {
    const id = await runningTask()
    const ask = openAsk(id, 'Ship the fix')
    const lost = await controlPlane().receive(ask)
    expect(lost.type).toBe('ask.answer')

    const again = await controlPlane().receive(ask)
    expect(again).toEqual(lost)
    const rows = await promptRows(id)
    expect(rows).toHaveLength(1)
    expect(again).toMatchObject({ answer: { promptId: rows[0]?.id, text: 'Ship the fix' } })
  })

  it('gets a row of its own for each message the node sends', async () => {
    const id = await runningTask()
    await controlPlane().receive(openAsk(id, 'First'))
    await controlPlane().receive(openAsk(id, 'Second'))
    expect((await promptRows(id)).map((row) => row.payload)).toMatchObject([{ text: 'First' }, { text: 'Second' }])
  })
})
