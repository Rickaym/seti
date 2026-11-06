import fs from 'node:fs'
import { auditQuery, chatSearchQuery, type TeamMessage, type TeamPosted } from '@seti/shared'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { asAgent } from './access.js'
import { createApp } from './app.js'
import { messages, tasks } from './db.js'
import { liveContext } from './ea-context.js'
import { promptAuthor } from './ea-guard.js'
import { endSession, runTurn } from './runner.js'
import { auditEvents } from './store/audit.js'
import { eaInbox } from './store/inbox.js'
import { teamSearch } from './store/search.js'
import { canRead, teamMessages, type TeamReader } from './store/team.js'
import { ensureMember, postTeamMessage } from './team.js'
import { EA_AUTH, USER_AUTH } from './test-auth.js'
import { waitIdle } from './wait-idle.js'
import { renderChat } from './workspace/chat.js'
import { chatView } from './workspace/render.js'

const scratch = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const nodePath = await import('node:path')
  const root = mkdtempSync(nodePath.join(tmpdir(), 'seti-team-direct-test-'))
  process.env.SETI_HOME = nodePath.join(root, 'seti')
  process.env.SETI_CLAUDE_HOME = nodePath.join(root, 'claude')
  return root
})

const sdk = await vi.hoisted(async () => {
  const { FakeSdk, fakeResult } = await import('./fake-sdk.js')
  return new FakeSdk(function* () {
    yield fakeResult()
  })
})

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  query: sdk.query,
}))

const app = createApp()
const HEADERS = { host: 'localhost', 'content-type': 'application/json' }
const SENDER = 'direct-sender'
const RECIPIENT = 'direct-recipient'
const BYSTANDER = 'direct-bystander'

for (const [id, title] of [
  [SENDER, 'Sender of secrets'],
  [RECIPIENT, 'Recipient of secrets'],
  [BYSTANDER, 'Bystander nearby'],
] as const) {
  await tasks.insert({ id, title, repo_id: null, cwd: scratch, worktree: false, pr_urls: [] })
  await ensureMember({ id, title })
}
const handle = async (id: string) => (await ensureMember({ id, title: '' })).handle

afterAll(async () => {
  for (const id of [SENDER, RECIPIENT, BYSTANDER]) {
    await endSession(id)
  }
  fs.rmSync(scratch, { recursive: true, force: true })
})

const post = async (path: string, body: unknown, auth: Record<string, string> = EA_AUTH) =>
  app.request(`/api${path}`, { method: 'POST', headers: { ...HEADERS, ...auth }, body: JSON.stringify(body) })

async function listed(auth: Record<string, string>): Promise<string[]> {
  const res = await app.request('/api/team/messages?limit=200', { headers: { ...HEADERS, ...auth } })
  return ((await res.json()) as { data: TeamMessage[] }).data.map((message) => message.text)
}

const prompts = async (id: string) =>
  (await messages.page(id, 100)).messages.flatMap((row) => (row.kind === 'prompt' ? [row.payload] : []))

const teamInputs = async (id: string) =>
  (await messages.page(id, 100)).messages.flatMap((row) =>
    row.kind === 'input' && row.payload.source === 'team' ? [row.payload] : [],
  )

describe('only the user writes prompts', () => {
  it('refuses the EA a message in an agent conversation, and lets the user', async () => {
    const res = await post(`/tasks/${RECIPIENT}/messages`, { prompt: 'Rebase on main' })
    expect(res.status).toBe(403)
    expect(await res.text()).toContain('The EA and agents message agents through the group chat')
    const empty = await post(`/tasks/${RECIPIENT}/retry`, { prompt: 'Rebase on main' })
    expect(empty.status).toBe(409)
    expect(await empty.text()).toContain('no message to send again')
    expect(await prompts(RECIPIENT)).toEqual([])
    expect((await post(`/tasks/${RECIPIENT}/messages`, { prompt: 'Hello' }, USER_AUTH)).status).toBe(200)
    await waitIdle(RECIPIENT)
  })

  it("lets the EA retry the user's last message, and never with text of its own", async () => {
    expect((await post(`/tasks/${RECIPIENT}/retry`, { prompt: 'Rebase on main' })).status).toBe(200)
    await waitIdle(RECIPIENT)
    expect(await prompts(RECIPIENT)).toEqual([{ text: 'Hello' }, { text: 'Hello', retry: true }])
    expect(sdk.prompts.join('\n')).not.toContain('Rebase on main')
    const [event] = (await auditEvents.page(auditQuery.parse({ kind: 'task.message_sent', limit: 1 }))).events
    expect(event).toMatchObject({ actor: 'user', subject_id: RECIPIENT, detail: { via: 'ea', retry: true } })
  })

  it('marks a first message the EA or an agent wrote, for the agent and in the transcript', async () => {
    const sender = await tasks.get(SENDER)
    if (sender === undefined) {
      throw new Error('the sender task is missing')
    }
    expect(await asAgent(sender, async () => Promise.resolve(promptAuthor()))).toBe('agent "Sender of secrets"')
    expect(promptAuthor()).toBeUndefined()
    await runTurn(BYSTANDER, 'Look at the flaky test', { from: 'the EA' })
    await waitIdle(BYSTANDER)
    const prompt = (await messages.page(BYSTANDER, 100)).messages.find((row) => row.kind === 'prompt')
    expect(prompt?.payload).toMatchObject({ text: 'Look at the flaky test', from: 'the EA' })
    expect(sdk.prompts.join('\n')).toContain('This message comes from the EA, not the user.\n\nLook at the flaky test')
    expect((await post(`/tasks/${BYSTANDER}/retry`, {})).status).toBe(200)
    await waitIdle(BYSTANDER)
    expect((await prompts(BYSTANDER)).at(-1)).toMatchObject({ from: 'the EA', retry: true })
    const told = sdk.prompts.filter((text) => text.includes('This message comes from the EA, not the user.'))
    expect(told).toHaveLength(2)
  })
})

describe('direct messages', () => {
  const secret = { ea: 'EA to recipient: the rollout plan', agents: 'Sender to recipient: the key id' }
  let fromEa: TeamPosted
  let between: TeamPosted
  let toEa: TeamPosted

  it('reach their one recipient like a mention and are audited without their text', async () => {
    const recipient = await handle(RECIPIENT)
    const res = await post('/team/messages', { text: secret.ea, to: `@${recipient}` })
    expect(res.status).toBe(200)
    fromEa = ((await res.json()) as { data: TeamPosted }).data
    expect(fromEa.message).toMatchObject({ author_kind: 'ea', to_kind: 'task', to_task_id: RECIPIENT })
    expect(fromEa.message.mentions).toEqual([{ handle: recipient, task_id: RECIPIENT }])
    expect(fromEa.deliveries).toEqual([{ task_id: RECIPIENT, handle: recipient, mode: 'start', reason: null }])
    await waitIdle(RECIPIENT)
    expect(await teamInputs(RECIPIENT)).toContainEqual(
      expect.objectContaining({ kind: 'direct', subject: 'ea', body: secret.ea }),
    )
    between = await postTeamMessage({ kind: 'task', taskId: SENDER }, `${secret.agents} @all`, { to: recipient })
    expect(between.deliveries.map((delivery) => delivery.task_id)).toEqual([RECIPIENT])
    toEa = await postTeamMessage({ kind: 'task', taskId: SENDER }, 'Sender to EA: may I merge?', { to: 'ea' })
    await waitIdle(RECIPIENT)
    expect(await teamInputs(BYSTANDER)).toEqual([])
    await auditEvents.settled()
    const audited = await auditEvents.latest('team.direct_posted')
    expect(audited).toMatchObject({ actor: 'agent', detail: { author: `@${await handle(SENDER)}`, to: 'ea' } })
    const all = (await auditEvents.page({ kind: 'team.direct_posted', limit: 10 })).events
    expect(all.map((event) => event.detail.length)).toEqual(expect.arrayContaining([secret.ea.length]))
    expect(JSON.stringify(all)).not.toMatch(/rollout plan|key id|may I merge/)
  })

  it('show to the user in full and to the EA only where it is a party', async () => {
    const user = await listed(USER_AUTH)
    expect(user).toEqual(expect.arrayContaining([secret.ea, between.message.text, toEa.message.text]))
    const ea = await listed(EA_AUTH)
    expect(ea).toEqual(expect.arrayContaining([secret.ea, toEa.message.text]))
    expect(ea).not.toContain(between.message.text)
    const search = await app.request('/api/team/search?q=key%20id', { headers: { ...HEADERS, ...EA_AUTH } })
    expect(((await search.json()) as { data: { hits: unknown[] } }).data.hits).toEqual([])
    const due = await eaInbox.due(new Date(Date.now() + 1000).toISOString(), 50, ['team_mention'])
    expect(due.at(-1)).toMatchObject({ event: 'direct', message_id: toEa.message.id })
  })

  it('stay out of a third agent reads, chat.md and search, and out of the shared live context', async () => {
    const bystander: TeamReader = { kind: 'task', taskId: BYSTANDER }
    const texts = (list: readonly TeamMessage[]) => list.map((message) => message.text)
    expect(texts(await teamMessages.list(bystander, 200))).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/rollout plan|key id|may I merge/)]),
    )
    const hits = await teamSearch.search(bystander, chatSearchQuery.parse({ q: 'secrets', mode: 'text' }))
    expect(hits.hits).toEqual([])
    const found = await teamSearch.search(
      { kind: 'task', taskId: RECIPIENT },
      chatSearchQuery.parse({ q: 'key id', mode: 'text' }),
    )
    expect(found.hits.map((hit) => hit.id)).toEqual([between.message.id])
    const thirdChat = renderChat(await chatView(BYSTANDER))
    expect(thirdChat).not.toMatch(/rollout plan|key id|may I merge|direct to/)
    const recipientChat = renderChat(await chatView(RECIPIENT))
    expect(recipientChat).toContain(`### ${String(fromEa.message.id)} ea, direct to you`)
    expect(recipientChat).toContain(secret.agents)
    expect((await liveContext()).text).not.toMatch(/rollout plan|key id|may I merge/)
    expect(canRead({ kind: 'public' }, fromEa.message)).toBe(false)
    expect(canRead({ kind: 'ea' }, between.message)).toBe(false)
    expect(canRead({ kind: 'task', taskId: SENDER }, between.message)).toBe(true)
  })

  it('refuse an unknown, reserved or own recipient', async () => {
    const refused = async (to: string, status: number) => {
      const res = await post('/team/messages', { text: 'hi', to }, USER_AUTH)
      expect(res.status, to).toBe(status)
    }
    await refused('@nobody-here', 404)
    await refused('@all', 400)
    await refused('@user', 400)
    expect((await post('/team/messages', { text: 'hi', to: 'ea' })).status).toBe(400)
    await expect(postTeamMessage({ kind: 'task', taskId: SENDER }, 'hi', { to: await handle(SENDER) })).rejects.toThrow(
      'not to yourself',
    )
  })

  it('get a direct answer when the EA replies to one sent to it', async () => {
    const res = await post('/team/messages', { text: 'Not yet; I asked the user.', reply_to: toEa.message.id })
    expect(res.status).toBe(200)
    const reply = ((await res.json()) as { data: TeamPosted }).data
    expect(reply.message).toMatchObject({ author_kind: 'ea', to_kind: 'task', to_task_id: SENDER })
    expect(reply.deliveries.map((delivery) => delivery.task_id)).toEqual([SENDER])
    expect(await listed(EA_AUTH)).toContain('Not yet; I asked the user.')
    expect(texts(await teamMessages.list({ kind: 'task', taskId: BYSTANDER }, 200))).not.toContain(
      'Not yet; I asked the user.',
    )
    await waitIdle(SENDER)
  })
})

const texts = (list: readonly TeamMessage[]) => list.map((message) => message.text)
