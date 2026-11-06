import { RESENT_NOTE, type PromptPayload } from '@seti/shared'
import { describe, expect, it, vi } from 'vitest'
import { messages, tasks } from './db.js'
import { resendDroppedPrompt, retryLastPrompt } from './dropped-prompt.js'
import { runTurn } from './runner.js'
import { waitIdle } from './wait-idle.js'

/** The first "swallow me" turn ends without calling the model, as Claude Code does after cleanup. */
const sdk = await vi.hoisted(async () => {
  const fakes = await import('./fake-sdk.js')
  const seen = new Map<string, number>()
  const fake = new fakes.FakeSdk(function* ({ text }) {
    const times = (seen.get(text) ?? 0) + 1
    seen.set(text, times)
    yield fakes.fakeMessage('system', {
      subtype: 'init',
      session_id: 'dropped',
      model: 'haiku',
      permissionMode: 'default',
    })
    if (text.includes('swallow me') && (times === 1 || text.includes('always'))) {
      yield { ...fakes.fakeResult(), num_turns: 0, result: '' }
      return
    }
    yield fakes.fakeAssistant(`answer to: ${text}`)
    yield fakes.fakeResult()
  })
  return { fake, query: fake.query }
})

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  query: sdk.query,
}))

let count = 0

async function newTask(): Promise<string> {
  count += 1
  const id = `dropped-${String(count)}`
  await tasks.insert({
    id,
    title: `Dropped ${String(count)}`,
    repo_id: null,
    cwd: '/tmp',
    worktree: false,
    pr_urls: [],
  })
  return id
}

const prompts = async (id: string): Promise<string[]> =>
  (await messages.page(id, 100)).messages.flatMap((row) => (row.kind === 'prompt' ? [row.payload.text] : []))

const payloads = async (id: string): Promise<PromptPayload[]> =>
  (await messages.page(id, 100)).messages.flatMap((row) => (row.kind === 'prompt' ? [row.payload] : []))

const notes = async (id: string): Promise<string[]> =>
  (await messages.page(id, 100)).messages.flatMap((row) => (row.kind === 'seti' ? [row.payload.error] : []))

describe('resendDroppedPrompt', () => {
  it('sends a message Claude Code closed without reading once more, with a note', async () => {
    const id = await newTask()
    await runTurn(id, 'swallow me please')
    await waitIdle(id)
    expect(await resendDroppedPrompt(id)).toBe(true)
    await waitIdle(id)
    expect(await prompts(id)).toEqual(['swallow me please', 'swallow me please'])
    expect(await notes(id)).toEqual([RESENT_NOTE])
    expect(await resendDroppedPrompt(id)).toBe(false)
  })

  it('resends at most once, and never answered messages or commands', async () => {
    const stuck = await newTask()
    await runTurn(stuck, 'always swallow me')
    await waitIdle(stuck)
    expect(await resendDroppedPrompt(stuck)).toBe(true)
    await waitIdle(stuck)
    expect(await resendDroppedPrompt(stuck)).toBe(false)
    expect(await prompts(stuck)).toHaveLength(2)

    const answered = await newTask()
    await runTurn(answered, 'hello there')
    await waitIdle(answered)
    expect(await resendDroppedPrompt(answered)).toBe(false)
  })
})

describe('retryLastPrompt', () => {
  it('sends the last message again as a new turn', async () => {
    const id = await newTask()
    await runTurn(id, 'hello there')
    await waitIdle(id)
    expect(await retryLastPrompt(id)).toEqual({ prompt: 'hello there', outcome: 'started' })
    await waitIdle(id)
    expect(await payloads(id)).toEqual([{ text: 'hello there' }, { text: 'hello there', retry: true }])
  })

  it('sends the message once when two retries come together', async () => {
    const id = await newTask()
    await runTurn(id, 'retry me once')
    await waitIdle(id)
    const outcomes = await Promise.allSettled([retryLastPrompt(id), retryLastPrompt(id)])
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.find((outcome) => outcome.status === 'rejected')?.reason).toMatchObject({ status: 409 })
    await waitIdle(id)
    expect(await prompts(id)).toEqual(['retry me once', 'retry me once'])
    expect(sdk.fake.prompts.filter((text) => text === 'retry me once')).toHaveLength(2)
  })

  it('keeps saying who wrote a message the EA or an agent wrote', async () => {
    const id = await newTask()
    await runTurn(id, 'from the lead', { from: 'the EA' })
    await waitIdle(id)
    await retryLastPrompt(id)
    await waitIdle(id)
    expect((await payloads(id)).at(-1)).toEqual({ text: 'from the lead', retry: true, from: 'the EA' })
    expect(sdk.fake.prompts.at(-1)).toBe('This message comes from the EA, not the user.\n\nfrom the lead')
  })

  it('refuses an agent with nothing to send again', async () => {
    const id = await newTask()
    await expect(retryLastPrompt(id)).rejects.toMatchObject({ status: 409 })
  })
})
