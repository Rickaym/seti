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
import { asides } from '../store/asides.js'
import { auditEvents } from '../store/audit.js'
import { costSince } from '../store/cost.js'
import { EA_AUTH, USER_AUTH } from '../test-auth.js'
import { withBundledMods } from '../test-mods.js'
import { waitIdle } from '../wait-idle.js'
import { prepareAsk, type Ask } from './ask.js'
import { closeAllChats } from './chats.js'
import { REPLAY_ANSWER_CHARS, REPLAY_EXCHANGES } from './history.js'
import { READ_TOOLS } from './options.js'
import { sessionFile } from './saved-cost.js'

const TOKEN = `ghp_${'a1B2c3D4e5'.repeat(4).slice(0, 36)}`

/** The agent's turns say what they were asked; a fork answers its question, then its cost. */
const sdk = await vi.hoisted(async () => {
  const { FakeSdk, aborted, fakeAssistant, fakeMessage, fakeResult } = await import('../fake-sdk.js')
  const state = {
    forkTotal: 0.05,
    forkReply: (text: string) => `Because: ${text}`,
    forkHold: false,
    forkNotice: false,
  }
  const fake = new FakeSdk(async function* ({ text, signal, session }) {
    if (session.options.forkSession === true && state.forkHold) {
      await aborted(signal)
      return
    }
    if (session.options.forkSession === true) {
      if (state.forkNotice) {
        yield { ...fakeResult(), session_id: 'fork-session', num_turns: 0, result: '' }
      }
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

async function sideChatAudits(
  id: string,
  kind: 'task.side_chat' | 'task.aside_deleted' | 'task.asides_cleared' = 'task.side_chat',
) {
  await auditEvents.settled()
  const { events } = await auditEvents.page({ kind, limit: 50 })
  return events.filter((event) => event.subject_id === id)
}

async function remove(id: string, aside?: string) {
  const url = aside === undefined ? `${ROUTES}/${id}/asides` : `${ROUTES}/${id}/asides/${aside}`
  return app.request(url, { method: 'DELETE', headers: { host: 'localhost', ...USER_AUTH } })
}

async function listed(id: string) {
  const res = await app.request(`${ROUTES}/${id}/asides`, { headers: { host: 'localhost', ...USER_AUTH } })
  return ((await res.json()) as { data: { asides: { id: string; question: string; asked_by: string }[] } }).data.asides
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
    expect(doneOf(events)).toMatchObject({
      text: 'Because: why did you do that?',
      aside: {
        task_id: id,
        question: 'why did you do that?',
        answer: 'Because: why did you do that?',
        asked_by: 'user',
      },
    })
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

  it('answers after the zero-turn result a waiting background notice makes', async () => {
    const id = await newAgent()
    sdk.state.forkNotice = true
    try {
      const { events } = await ask(id, 'what is the latest?')
      expect(doneOf(events)).toMatchObject({ text: 'Because: what is the latest?', cost_usd: 0.05 })
    } finally {
      sdk.state.forkNotice = false
    }
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

  it('stores the exchange as an aside, never as a transcript row or in the session', async () => {
    const id = await newAgent()
    const before = await agentState(id)
    const { events } = await ask(id, 'what did you find?')
    const done = doneOf(events)
    expect(await asides.list(id)).toEqual([done?.type === 'done' ? done.aside : null])
    expect(await agentState(id)).toEqual(before)
    const transcript = JSON.stringify((await messages.page(id, 500)).messages)
    expect(transcript).not.toContain('what did you find?')
    expect(lastFork().options).toMatchObject({ forkSession: true, persistSession: false })
  })

  it('hands a follow-up the earlier exchanges from the table, also after a restart', async () => {
    const id = await newAgent()
    const first = await ask(id, 'first question')
    const chatId = chatOf(first.events)
    closeAllChats()
    const second = await ask(id, 'and then?', chatId)
    expect(chatOf(second.events)).toBe(chatId)
    expect(lastFork().prompts[0]).toContain('Question: first question')
    expect(lastFork().prompts[0]).toContain('Answer: Because: first question')
    expect(lastFork().prompts[0]).toMatch(/New question:\nand then\?$/)
    expect((await asides.chat(id, chatId, 10)).map((a) => a.question)).toEqual(['first question', 'and then?'])
  })

  it('replays only the newest exchanges of a long chat, each answer cut short', async () => {
    const id = await newAgent()
    const chatId = '00000000-0000-4000-8000-00000000c0de'
    for (let i = 1; i <= REPLAY_EXCHANGES + 2; i++) {
      await asides.add({
        id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        task_id: id,
        chat_id: chatId,
        question: `question ${String(i)}`,
        answer: i === REPLAY_EXCHANGES + 2 ? 'x'.repeat(REPLAY_ANSWER_CHARS * 2) : `answer ${String(i)}`,
        asked_by: 'user',
        asker_id: null,
        asker_title: null,
        cost_usd: null,
        asked_at: `2026-11-11T10:00:${String(i).padStart(2, '0')}.000Z`,
        answered_at: `2026-11-11T10:00:${String(i).padStart(2, '0')}.500Z`,
      })
    }
    await ask(id, 'what now?', chatId)
    const prompt = lastFork().prompts[0] ?? ''
    expect(prompt).not.toContain('Question: question 2\n')
    expect(prompt).toContain('Question: question 3\n')
    expect(prompt).toContain(`Answer: ${'x'.repeat(REPLAY_ANSWER_CHARS - 3)}...`)
    expect(prompt).not.toContain('x'.repeat(REPLAY_ANSWER_CHARS))
  })

  it('refuses a follow-up in a chat whose asides were deleted', async () => {
    const id = await newAgent()
    const chatId = chatOf((await ask(id, 'first question')).events)
    expect((await remove(id)).status).toBe(200)
    const gone = await ask(id, 'still there?', chatId)
    expect(gone.status).toBe(404)
    expect(await gone.res.text()).toContain('That side chat is gone')
  })

  it('deletes one aside or all of them and audits each without the content', async () => {
    const id = await newAgent()
    await ask(id, 'secret plan one')
    await ask(id, 'secret plan two')
    await ask(id, 'secret plan three')
    const [first] = await listed(id)
    expect((await remove(id, first?.id)).status).toBe(200)
    expect((await listed(id)).map((a) => a.question)).toEqual(['secret plan two', 'secret plan three'])
    expect((await remove(id, first?.id)).status).toBe(404)
    expect((await remove(id)).status).toBe(200)
    expect(await listed(id)).toEqual([])
    const deleted = await sideChatAudits(id, 'task.aside_deleted')
    const cleared = await sideChatAudits(id, 'task.asides_cleared')
    expect(deleted).toHaveLength(1)
    expect(cleared[0]).toMatchObject({ summary: `Cleared 2 asides of agent "Side ${String(taskCount)}"` })
    expect(cleared[0]?.detail).toMatchObject({ count: 2 })
    expect(JSON.stringify([deleted, cleared])).not.toMatch(/secret plan|Because/)
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
    expect(doneOf(events)?.type).toBe('done')
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
    const [stored] = await asides.list(id)
    expect(stored?.answer).toContain('The token was')
    expect(stored?.answer).not.toContain(TOKEN)
  })

  it('refuses an agent with no conversation yet', async () => {
    const id = `side-chat-empty-${String(++taskCount)}`
    await tasks.insert({ id, title: 'Empty', repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })
    const { status, res } = await ask(id, 'anything?')
    expect(status).toBe(409)
    expect(await res.text()).toContain('no conversation')
  })

  it("answers the EA's run_mod_action in one piece, as the EA, and keeps it as the EA's aside", async () => {
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
    expect(await asides.list(id)).toMatchObject([{ question: 'status?', asked_by: 'ea', asker_id: null }])
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
    expect(await asides.list(id)).toMatchObject([
      { asked_by: 'agent', asker_id: caller, asker_title: callerTask.title },
    ])
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
