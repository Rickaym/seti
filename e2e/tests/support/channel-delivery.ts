import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { APIRequestContext, Locator, Page } from '@playwright/test'
import {
  type ChannelSubscription,
  type DeliveryTiming,
  type Envelope,
  isClaudeRow,
  type MessageRow,
  type ReminderChannelInfo,
  type Task,
} from '@seti/shared'
import { openAgentSettings, settingsDialog } from './agent-settings.js'
import { paths } from './env.js'
import { BURST_COMMANDS, BURST_DONE, burstPrompt, JOINED_REPLY, releaseStep } from './fake-steps.js'
import { apiData, expect } from './fixtures.js'
import { expectFitsPhone } from './phone-layout.js'

/** A click on desktop, a tap on a phone. */
type Press = (target: Locator) => Promise<void>

interface Flow {
  page: Page
  request: APIRequestContext
  press: Press
  phone: boolean
}

interface Scene extends Flow {
  agent: Task
  reminder: ReminderChannelInfo
}

/** Seti hands waking updates over once none came for this long (WAKE_DEBOUNCE.quietMs). */
const QUIET_MS = 5_000
const HANDED = { timeout: 20_000 }
const STARTED = 'Running the checks.'
const REPLY = 'Done.'

const SCRIPT = `export default ({ state }) => {
  const count = (state ?? 0) + 1
  return { message: 'Check the deploy, round ' + count, state: count }
}`

/** A daily run twelve hours away, so the schedule never adds an event to the ones the flow fires. */
const farFromNow = (): string => `0 ${String((new Date().getUTCHours() + 12) % 24)} * * *`

async function post<T>(request: APIRequestContext, url: string, data: object = {}): Promise<T> {
  const response = await request.post(`/api${url}`, { data })
  expect(response.ok(), `POST /api${url}`).toBe(true)
  return ((await response.json()) as Envelope<T>).data
}

const rows = async ({ request, agent }: Scene) =>
  apiData<{ messages: MessageRow[] }>(request, `/tasks/${agent.id}/messages?limit=200`)

/** What the agent said so far, one entry per text it wrote. */
async function said(scene: Scene): Promise<string[]> {
  return (await rows(scene)).messages.flatMap((row) => {
    if (!isClaudeRow(row) || row.payload.type !== 'assistant') {
      return []
    }
    return row.payload.message.content.flatMap((block) => (block.type === 'text' ? [block.text] : []))
  })
}

const idle = async ({ request, agent }: Scene) =>
  expect.poll(async () => (await apiData<Task>(request, `/tasks/${agent.id}`)).status, HANDED).toBe('idle')

/** Runs the reminder now, which sends its subscribers one new event. */
const fire = async ({ request, reminder }: Scene) => post(request, `/channels/reminders/${reminder.id}/run`)

const delivery = async ({ request, agent }: Scene) =>
  (await apiData<ChannelSubscription[]>(request, `/tasks/${agent.id}/channels`))[0]?.delivery

/** Starts a turn of gated shell calls and returns the folder that releases them. */
async function startChecks(scene: Scene, turns: number): Promise<string> {
  const gate = fs.mkdtempSync(path.join(paths.root, 'delivery-gate-'))
  await post(scene.request, `/tasks/${scene.agent.id}/messages`, { prompt: burstPrompt(gate) })
  await expect.poll(async () => (await said(scene)).filter((text) => text === STARTED)).toHaveLength(turns)
  return gate
}

function releaseRest(gate: string, from: number): void {
  for (let n = from; n < BURST_COMMANDS.length; n++) {
    releaseStep(gate, n)
  }
}

/** Picks a delivery in the open picker and waits for Seti to store it. */
async function choose(scene: Scene, picker: Locator, label: string, stored: DeliveryTiming | null): Promise<void> {
  const { page, press } = scene
  await press(picker)
  const options = page.getByRole('list', { name: /^Delivery for / })
  await expect(options.getByRole('button')).toHaveText([/^Agent default/, /^Now/, /^After turn/, /^With message/])
  await expect(options.locator('..')).toContainText("The agent's Updates setting caps this")
  await press(options.getByRole('button', { name: new RegExp(`^${label}`) }))
  await expect(options).toHaveCount(0)
  await expect.poll(async () => delivery(scene)).toBe(stored)
}

/** Subscribes the agent on the channel's card, which follows the agent, then picks Now there. */
async function subscribeOnCard(scene: Scene): Promise<void> {
  const { page, press, phone, agent, reminder } = scene
  await page.goto(`/#settings/channels/${reminder.id}`)
  const card = page.getByRole('main').getByRole('region', { name: reminder.name })
  const add = card.getByRole('button', { name: 'Agent', exact: true })
  await press(add)
  await press(page.getByRole('list', { name: 'Agents to subscribe' }).getByRole('button', { name: agent.title }))
  // The closing agent list hands focus back to its button, which shuts a picker opened before that.
  await expect(add).toBeFocused()
  const picker = card.getByRole('button', { name: new RegExp(`^${agent.title} delivery: `) })
  await expect(picker).toHaveAttribute('data-delivery', 'agent')
  await expect(picker).toHaveText('Agent default')
  await choose(scene, picker, 'Now', 'now')
  await expect(picker).toHaveText('Now')
  if (phone) {
    await expectFitsPhone(page, 'the subscriber list with a delivery')
  }
}

/** Picks a delivery in the Channels row of the agent's own settings. */
async function chooseOnAgent(scene: Scene, label: string, stored: DeliveryTiming): Promise<void> {
  const { page, phone, agent, reminder } = scene
  await page.goto(`/#agents/${agent.id}`)
  await openAgentSettings(page, 'Team')
  const picker = page.getByTestId('task-channels').getByRole('button', {
    name: new RegExp(`^${reminder.name} delivery: `),
  })
  await choose(scene, picker, label, stored)
  await expect(picker).toHaveAttribute('data-delivery', stored)
  if (phone) {
    await expectFitsPhone(page, 'the agent channels with a delivery')
  }
  await page.keyboard.press('Escape')
  await expect(settingsDialog(page)).toHaveCount(0)
}

/** Now: an idle agent starts a turn, and a running turn takes the update at its next step. */
async function nowReachesAtOnce(scene: Scene): Promise<void> {
  const { page, agent } = scene
  await fire(scene)
  await page.goto(`/#agents/${agent.id}`)
  const main = page.getByRole('main')
  await expect(main.getByText('Seti started a turn to hand the agent 1 update')).toBeVisible(HANDED)
  await expect.poll(async () => said(scene)).toEqual([REPLY, REPLY])
  await idle(scene)

  const gate = await startChecks(scene, 1)
  await fire(scene)
  await expect(main.getByText('Seti queued 1 update for the agent')).toBeVisible(HANDED)
  expect(await said(scene)).not.toContain(JOINED_REPLY)
  releaseStep(gate, 0)
  await expect.poll(async () => said(scene)).toEqual([REPLY, REPLY, STARTED, JOINED_REPLY])
  expect((await apiData<Task>(scene.request, `/tasks/${agent.id}`)).status).toBe('running')
  releaseRest(gate, 1)
  await expect.poll(async () => said(scene)).toEqual([REPLY, REPLY, STARTED, JOINED_REPLY, BURST_DONE])
  await idle(scene)
  expect((await said(scene)).at(-1)).toBe(BURST_DONE)
}

/** After turn: the update stays out of the running turn and gets a turn of its own after it. */
async function afterTurnWaits(scene: Scene): Promise<void> {
  const before = await said(scene)
  const gate = await startChecks(scene, 2)
  await fire(scene)
  await expect
    .poll(async () => (await rows(scene)).messages.filter((row) => row.kind === 'prompt').at(-1)?.payload, HANDED)
    .toMatchObject({ auto: true, queued: 'waiting' })
  releaseStep(gate, 0)
  releaseStep(gate, 1)
  await scene.page.waitForTimeout(1_000)
  expect(await said(scene)).toEqual([...before, STARTED])
  releaseRest(gate, 2)
  await expect.poll(async () => said(scene), HANDED).toEqual([...before, STARTED, BURST_DONE, REPLY])
  await idle(scene)
}

/** With message: the update waits in the bar, starts nothing, and goes with the next message. */
async function withMessageHolds(scene: Scene): Promise<void> {
  const { page, request, agent } = scene
  const before = await said(scene)
  await fire(scene)
  await page.goto(`/#agents/${agent.id}`)
  const bar = page.getByTestId('queued-inputs')
  await expect(bar).toHaveAttribute('data-waiting', 'message')
  await expect(bar).toContainText('1 queued')
  await page.waitForTimeout(QUIET_MS + 2_000)
  expect(await said(scene)).toEqual(before)
  await expect(bar.getByRole('button', { name: 'Hand over' })).toBeVisible()
  await expect(bar.getByRole('button', { name: 'Dismiss' })).toBeVisible()

  await post(request, `/tasks/${agent.id}/messages`, { prompt: 'thanks' })
  await expect.poll(async () => said(scene)).toEqual([...before, REPLY])
  await expect(bar).toHaveCount(0)
  const sent = (await rows(scene)).messages.filter((row) => row.kind === 'prompt').at(-1)
  expect(sent?.payload).toMatchObject({ text: 'thanks', inputs: 1 })
}

/** The Schedule tab and the subscriber list name the chosen delivery. */
async function labelsShowTheChoice(scene: Scene): Promise<void> {
  const { page, press, phone, agent, reminder } = scene
  await page.goto('/#settings/channels')
  const main = page.getByRole('main')
  await press(main.getByRole('tab', { name: 'Schedule' }))
  const run = main.getByRole('button', { name: reminder.name }).first()
  await expect(run.locator('[data-delivery="with_message"]')).toHaveText('With message')
  if (phone) {
    await expectFitsPhone(page, 'the schedule with a delivery')
  }
  await press(run)
  const card = main.getByRole('region', { name: reminder.name })
  await expect(card.getByRole('button', { name: `${agent.title} delivery: With message` })).toHaveText('With message')
}

/** Sets a subscription to each delivery and checks when the agent gets the channel's update. */
export async function deliveryFollowsTheChoice(flow: Flow): Promise<void> {
  const { request } = flow
  const tag = randomUUID().slice(0, 8)
  const agent = await post<Task>(request, '/tasks', {
    title: `Delivery agent ${tag}`,
    prompt: 'hello',
    cwd: paths.checkout,
    sandbox: false,
  })
  const reminder = await post<ReminderChannelInfo>(request, '/channels/reminders', {
    name: `Delivery nudge ${tag}`,
    script: SCRIPT,
    schedule: { cron: farFromNow(), timezone: 'UTC' },
  })
  const scene: Scene = { ...flow, agent, reminder }
  try {
    await idle(scene)
    await subscribeOnCard(scene)
    await nowReachesAtOnce(scene)
    await chooseOnAgent(scene, 'After turn', 'after_turn')
    await afterTurnWaits(scene)
    await chooseOnAgent(scene, 'With message', 'with_message')
    await withMessageHolds(scene)
    await labelsShowTheChoice(scene)
  } finally {
    await request.delete(`/api/channels/${reminder.id}`)
  }
}
