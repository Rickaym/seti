import fs from 'node:fs'
import path from 'node:path'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import { sideChatEvent, type SideChatEvent } from '@seti/shared'
import { describe, expect, it, vi } from 'vitest'
import { asAgent } from '../access.js'
import { createApp } from '../app.js'
import { CLAUDE_HOME } from '../config.js'
import { messages, tasks } from '../db.js'
import type { FakeSession } from '../fake-sdk.js'
import { modHost } from '../mods/bundled.js'
import { isRunning, runTurn, stopTurn } from '../runner.js'
import { modActionTools } from '../seti-tools/mod-actions.js'
import { auditEvents } from '../store/audit.js'
import { costSince } from '../store/cost.js'
import { EA_AUTH, USER_AUTH } from '../test-auth.js'
import { withBundledMods } from '../test-mods.js'
import { waitIdle } from '../wait-idle.js'
import { prepareAsk, type Ask } from './ask.js'
import { READ_TOOLS } from './options.js'
import { sessionFile } from './saved-cost.js'

const TOKEN = `ghp_${'a1B2c3D4e5'.repeat(4).slice(0, 36)}`

/** The agent's turns say what they were asked; a fork answers its question, then its cost. */
const sdk = await vi.hoisted(async () => {
  const { FakeSdk, aborted, fakeAssistant, fakeMessage, fakeResult } = await import('../fake-sdk.js')
  const state = { forkTotal: 0.05, forkReply: (text: string) => `Because: ${text}`, forkHold: false }
  const fake = new FakeSdk(async function* ({ text, signal, session }) {
    if (session.options.forkSession === true && state.forkHold) {
      await aborted(signal)
      return
    }
    if (session.options.forkSession === true) {
      const reply = state.forkReply(text)
      const delta = { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply } }
      yield fakeMessage('stream_event', { parent_tool_use_id: null, event: delta })
      yield fakeAssistant(reply)
      yield { ...fakeResult(), session_id: 'fork-session', total_cost_usd: state.forkTotal }
      return
    }
    yield fakeMessage('system', {
      subtype: 'init',
      session_id: 'agent-session',
      model: 'opus',
      permissionMode: 'default',
    })
    yield fakeAssistant(`working on: ${text}`)
    if (text === 'hold') {
      await aborted(signal)
      return
    }
    yield fakeResult()
  })
  return { fake, query: fake.query, state }
})

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  query: sdk.query,
}))

const app = createApp()
let taskCount = 0

withBundledMods()

/** The side chat mod's routes, which hand questions to the engine. */
const ROUTES = '/api/mods/side-chat/tasks'

async function newAgent(firstPrompt = 'fix the bug'): Promise<string> {
  const id = `side-chat-task-${String(++taskCount)}`
  await tasks.insert({
    id,
    title: `Side ${String(taskCount)}`,
    repo_id: null,
    cwd: '/tmp',
    worktree: false,
    pr_urls: [],
  })
  await runTurn(id, firstPrompt)
  if (firstPrompt !== 'hold') {
    await waitIdle(id)
  }
  return id
}

const forks = () => sdk.fake.sessions.filter((s) => s.options.forkSession === true)
const agentSessions = () => sdk.fake.sessions.filter((s) => s.options.forkSession !== true)
const lastFork = (): FakeSession => {
  const fork = forks().at(-1)
  if (fork === undefined) {
    throw new Error('No side chat started')
  }
  return fork
}

function parseEvents(text: string): SideChatEvent[] {
  return text
    .split('\n\n')
    .flatMap((chunk) => chunk.split('\n').filter((line) => line.startsWith('data:')))
    .map((line) => sideChatEvent.parse(JSON.parse(line.slice('data:'.length))))
}

async function ask(id: string, question: string, chatId?: string, auth = USER_AUTH) {
  const res = await app.request(`${ROUTES}/${id}`, {
    method: 'POST',
    headers: { host: 'localhost', 'content-type': 'application/json', ...auth },
    body: JSON.stringify({ question, ...(chatId === undefined ? {} : { chat_id: chatId }) }),
  })
  return { status: res.status, events: res.ok ? parseEvents(await res.text()) : [], res }
}

const doneOf = (events: SideChatEvent[]) => events.find((e) => e.type === 'done')
const chatOf = (events: SideChatEvent[]) => {
  const start = events.find((e) => e.type === 'start')
  if (start?.type !== 'start') {
    throw new Error('The side chat did not start')
  }
  return start.chat_id
}

async function sideChatAudits(id: string) {
  await auditEvents.settled()
  const { events } = await auditEvents.page({ kind: 'task.side_chat', limit: 50 })
  return events.filter((event) => event.subject_id === id)
}

/** What a side chat must leave alone: the agent's transcript, session and process. */
async function agentState(id: string) {
  const task = await tasks.get(id)
  const rows = (await messages.page(id, 500)).messages.map((row) => row.id)
  return { rows, session: task?.session_id, status: task?.status, prompts: agentSessions().flatMap((s) => s.prompts) }
}

describe('side chat', () => {
  it("answers from a fork of the agent's session that Claude Code never saves", async () => {
    const id = await newAgent()
    const before = await agentState(id)
    const { status, events } = await ask(id, 'why did you do that?')
    expect(status).toBe(200)
    expect(events.map((e) => e.type)).toEqual(['start', 'text', 'text', 'done'])
    expect(doneOf(events)).toMatchObject({ text: 'Because: why did you do that?', turns_left: 7 })
    const options: Options = lastFork().options
    expect(options).toMatchObject({
      resume: 'agent-session',
      forkSession: true,
      persistSession: false,
      tools: READ_TOOLS,
      allowedTools: READ_TOOLS,
      permissionMode: 'dontAsk',
      mcpServers: {},
      strictMcpConfig: true,
      model: 'opus',
      settings: { disableAllHooks: true },
    })
    expect(options.allowedTools).not.toContain('Bash')
    expect(options.plugins).toBeUndefined()
    expect(options.canUseTool).toBeUndefined()
    expect(await agentState(id)).toEqual(before)
  })

  it('answers while the agent works, without touching its turn', async () => {
    const id = await newAgent('hold')
    await vi.waitFor(async () => {
      const rows = (await messages.page(id, 10)).messages
      expect(rows.some((row) => row.kind === 'sdk' && row.payload.type === 'assistant')).toBe(true)
    })
    const before = await agentState(id)
    const { events } = await ask(id, 'what are you doing?')
    expect(doneOf(events)?.type).toBe('done')
    expect(await agentState(id)).toEqual(before)
    expect(isRunning(id)).toBe(true)
    await stopTurn(id)
  })

  it('hands a follow-up the earlier exchange and forgets the chat once closed', async () => {
    const id = await newAgent()
    const first = await ask(id, 'first question')
    const chatId = chatOf(first.events)
    const second = await ask(id, 'and then?', chatId)
    expect(doneOf(second.events)).toMatchObject({ turns_left: 6 })
    expect(lastFork().prompts[0]).toContain('Question: first question')
    expect(lastFork().prompts[0]).toContain('Answer: Because: first question')
    expect(lastFork().prompts[0]).toMatch(/New question:\nand then\?$/)
    const closed = await app.request(`${ROUTES}/${id}/chats/${chatId}`, {
      method: 'DELETE',
      headers: { host: 'localhost', ...USER_AUTH },
    })
    expect(closed.status).toBe(200)
    expect((await ask(id, 'still there?', chatId)).status).toBe(404)
  })

  it('takes a follow-up asked the moment the answer is done, and keeps it answering', async () => {
    const id = await newAgent()
    const first = await prepareAsk(id, { question: 'first question' }, true)
    const asked: Ask[] = []
    await first.run(async (event) => {
      if (event.type === 'done') {
        asked.push(await prepareAsk(id, { question: 'and then?', chat_id: first.chatId }, true))
      }
    })
    expect(asked).toHaveLength(1)
    const third = prepareAsk(id, { question: 'and after?', chat_id: first.chatId }, true)
    await expect(third).rejects.toThrow('The side chat is still answering')
    const events: SideChatEvent[] = []
    await asked[0]?.run(async (event) => {
      events.push(event)
      return Promise.resolve()
    })
    expect(doneOf(events)).toMatchObject({ turns_left: 6 })
  })

  it('audits the start of each chat once, without its content', async () => {
    const id = await newAgent()
    const { events } = await ask(id, 'secret plan question')
    await ask(id, 'follow-up', chatOf(events))
    const audited = await sideChatAudits(id)
    expect(audited).toHaveLength(1)
    expect(JSON.stringify(audited)).not.toMatch(/secret plan|follow-up|Because/)
  })

  it("adds what the answer cost to the agent's cost, counted from the total its session saved", async () => {
    const id = await newAgent()
    const file = sessionFile('agent-session', '/tmp', CLAUDE_HOME)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const saved = [
      JSON.stringify({ type: 'cost-state', totalCostUSD: 0.5 }),
      JSON.stringify({ type: 'cost-state', totalCostUSD: 1 }),
      JSON.stringify({ type: 'assistant', message: { content: [] } }),
    ].join('\n')
    fs.writeFileSync(file, `${saved}\n`)
    const costBefore = (await tasks.get(id))?.cost_usd ?? Number.NaN
    const today = await costSince('1970-01-01')
    sdk.state.forkTotal = 1.25
    const { events } = await ask(id, 'how much?').finally(() => {
      sdk.state.forkTotal = 0.05
    })
    expect(doneOf(events)).toMatchObject({ cost_usd: 0.25 })
    expect((await tasks.get(id))?.cost_usd).toBeCloseTo(costBefore + 0.25)
    expect(await costSince('1970-01-01')).toBeCloseTo(today + 0.25)
    expect(fs.readFileSync(file, 'utf8')).toBe(`${saved}\n`)
    fs.rmSync(file)
  })

  it('redacts credentials in the answer', async () => {
    const id = await newAgent()
    sdk.state.forkReply = () => `The token was ${TOKEN} all along`
    const { events } = await ask(id, 'which token?')
    sdk.state.forkReply = (text) => `Because: ${text}`
    expect(JSON.stringify(events)).not.toContain(TOKEN)
    expect(doneOf(events)?.type).toBe('done')
  })

  it('refuses an agent with no conversation yet', async () => {
    const id = `side-chat-empty-${String(++taskCount)}`
    await tasks.insert({ id, title: 'Empty', repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })
    const { status, res } = await ask(id, 'anything?')
    expect(status).toBe(409)
    expect(await res.text()).toContain('no conversation')
  })

  it("answers the EA's run_mod_action in one piece, as the EA, and closes the chat", async () => {
    const id = await newAgent()
    const res = await app.request('/api/mods/side-chat/actions/ask', {
      method: 'POST',
      headers: { host: 'localhost', 'content-type': 'application/json', ...EA_AUTH },
      body: JSON.stringify({ args: { task: id, question: 'status?' } }),
    })
    expect(res.status).toBe(200)
    const { data } = (await res.json()) as { data: { text: string; result: unknown } }
    expect(data.text).toBe(`Side ${String(taskCount)} answers aside: Because: status?`)
    expect(data.result).toMatchObject({ id, answer: 'Because: status?', cost_usd: 0.05 })
    const audited = await sideChatAudits(id)
    expect(audited[0]?.detail).toMatchObject({ via: 'ea', reads_files: true })
  })

  it('gives agents asking with mod_side-chat_ask no tools in the fork, and refuses asking themselves', async () => {
    const id = await newAgent()
    const caller = await newAgent()
    await tasks.setSetiControl(caller, 'full')
    const callerTask = await tasks.get(caller)
    const tool = modActionTools('full').find((entry) => entry.name === 'mod_side-chat_ask')
    expect(modActionTools('self').map((entry) => entry.name)).not.toContain('mod_side-chat_ask')
    if (tool === undefined || callerTask === undefined) {
      throw new Error('mod_side-chat_ask or the caller is missing')
    }
    const asked = async (task: string) =>
      asAgent(callerTask, async () => tool.call({ task, question: 'why?' }, { caller: callerTask }))
    const answer = await asked(id)
    expect(answer).toContain('<mod_output mod="side-chat">')
    expect(answer).toContain(`"id":"${id}"`)
    expect(answer).toContain('"answer":"Because: why?"')
    expect(lastFork().options).toMatchObject({ tools: [], allowedTools: [], maxTurns: 1 })
    await expect(asked(caller)).rejects.toThrow(/yourself/)
  })

  it('stops an answer and its route when the side chat mod turns off', async () => {
    const id = await newAgent()
    sdk.state.forkHold = true
    const asking = ask(id, 'slow one')
    await vi.waitFor(() => {
      expect(forks().at(-1)?.prompts[0]).toBe('slow one')
    })
    await modHost.setEnabled('side-chat', false)
    try {
      const { events } = await asking
      expect(events.find((e) => e.type === 'error')).toMatchObject({ error: 'The side chat was closed' })
      expect((await ask(id, 'still there?')).status).toBe(404)
    } finally {
      sdk.state.forkHold = false
      await modHost.setEnabled('side-chat', true)
    }
  })
})
