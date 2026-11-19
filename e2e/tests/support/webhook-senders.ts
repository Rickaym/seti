import { createHmac, randomUUID } from 'node:crypto'
import type { APIRequestContext, Locator, Page } from '@playwright/test'
import type { ChannelInfo, Envelope, Task, WebhookChannelInfo } from '@seti/shared'
import { paths } from './env.js'
import { apiData, expect } from './fixtures.js'
import { expectFitsPhone } from './phone-layout.js'

/** A click on desktop, a tap on a phone. */
type Press = (target: Locator) => Promise<void>

export interface SenderFlow {
  page: Page
  request: APIRequestContext
  press: Press
  phone: boolean
}

const LINEAR_SECRET = ['lin', 'wh', 'fake', 'secret', 'for', 'e2e'].join('_')
const ACME_SECRET = ['acme', 'fake', 'secret', 'for', 'e2e'].join('-')
const HANDED = { timeout: 20_000 }

const hex = (secret: string, body: string) => createHmac('sha256', secret).update(body).digest('hex')

async function post<T>(request: APIRequestContext, url: string, data: object = {}): Promise<T> {
  const response = await request.post(`/api${url}`, { data })
  expect(response.ok(), `POST /api${url}`).toBe(true)
  return ((await response.json()) as Envelope<T>).data
}

async function channelNamed(request: APIRequestContext, name: string): Promise<WebhookChannelInfo> {
  const found = (await apiData<ChannelInfo[]>(request, '/channels')).find((info) => info.name === name)
  if (found?.source !== 'webhook') {
    throw new Error(`no webhook named ${name}`)
  }
  return found
}

async function removeChannel(request: APIRequestContext, name: string): Promise<void> {
  const found = (await apiData<ChannelInfo[]>(request, '/channels')).find((info) => info.name === name)
  if (found !== undefined) {
    await request.delete(`/api/channels/${found.id}`)
  }
}

/** Opens New, Webhook, which starts with the picker of apps. */
async function openPicker({ page, press }: SenderFlow): Promise<Locator> {
  await page.goto('/#settings/channels')
  await press(page.getByRole('main').getByRole('button', { name: 'New', exact: true }))
  await press(page.getByRole('list', { name: 'Channel sources' }).getByRole('button', { name: /Webhook/ }))
  const picker = page.getByRole('dialog', { name: 'New webhook' })
  await expect(picker.getByRole('list', { name: 'Senders' })).toBeVisible()
  return picker
}

/** Picks Linear by search, names the webhook, then pastes the signing secret beside the URL. */
async function createLinear(flow: SenderFlow, name: string): Promise<WebhookChannelInfo> {
  const { page, press, phone, request } = flow
  const picker = await openPicker(flow)
  const senders = picker.getByRole('list', { name: 'Senders' })
  await expect(senders.getByRole('button', { name: 'Seti signature', exact: true })).toBeVisible()
  await picker.getByRole('textbox', { name: 'Search senders', exact: true }).fill('linear')
  await expect(senders.getByRole('button')).toHaveText([/Linear/])
  await expect(senders.locator('[data-service-icon="linear"]')).toBeVisible()
  if (phone) {
    await expectFitsPhone(page, 'the sender picker')
  }
  await press(senders.getByRole('button', { name: 'Linear', exact: true }))

  const form = page.getByRole('dialog', { name: 'New Linear webhook' })
  await form.getByRole('textbox', { name: 'Name', exact: true }).fill(name)
  await expect(form.getByLabel('Signing secret')).toHaveAttribute('type', 'password')
  await press(form.getByRole('switch', { name: 'EA delivery' }))
  await press(form.getByRole('button', { name: 'issue.create', exact: true }))
  await expect(form.getByRole('textbox', { name: 'Events', exact: true })).toHaveValue('issue.create')
  if (phone) {
    await expectFitsPhone(page, 'the new webhook form')
  }
  await press(form.getByRole('button', { name: 'Create', exact: true }))

  const made = page.getByRole('dialog', { name })
  await expect(made.getByTestId('webhook-url')).toContainText('/hooks/')
  await expect(made.getByRole('button', { name: 'Copy url', exact: true })).toBeVisible()
  await expect(made.getByRole('list', { name: 'Setup steps' }).getByRole('listitem')).toHaveCount(3)
  await expect(made).toContainText('In Linear, open Settings, API and choose New webhook.')
  if (phone) {
    await expectFitsPhone(page, 'the new webhook with its steps')
  }
  await made.getByLabel('Signing secret').fill(LINEAR_SECRET)
  await press(made.getByRole('button', { name: 'Save', exact: true }))
  await expect(made).toContainText('Linear issued the secret, so Seti does not show it.')
  await expect(made).not.toContainText(LINEAR_SECRET)
  await press(made.getByRole('button', { name: 'Done', exact: true }))

  const channel = await channelNamed(request, name)
  expect(channel).toMatchObject({ preset: 'linear', secret_pending: null })
  expect(channel.subscriptions.map((sub) => [sub.target, sub.events])).toEqual([['ea', ['issue.create']]])
  return channel
}

async function linearDelivery(
  request: APIRequestContext,
  channel: WebhookChannelInfo,
  title: string,
  secret = LINEAR_SECRET,
) {
  const body = JSON.stringify({
    type: 'Issue',
    action: 'create',
    url: 'https://linear.app/acme/issue/ENG-7',
    webhookTimestamp: Date.now(),
    data: { title },
  })
  return request.post(channel.path, {
    headers: {
      'content-type': 'application/json',
      'linear-signature': hex(secret, body),
      'linear-delivery': randomUUID(),
      'linear-event': 'Issue',
    },
    data: body,
  })
}

/**
 * A Linear webhook made from the picker hands a correctly signed delivery to the subscribed
 * agent, and shows a badly signed one in its delivery log as refused.
 */
export async function linearReachesTheAgent(flow: SenderFlow): Promise<void> {
  const { page, press, request, phone } = flow
  const tag = randomUUID().slice(0, 8)
  const name = `Linear ${tag}`
  const agent = await post<Task>(request, '/tasks', {
    title: `Tracker agent ${tag}`,
    prompt: 'hello',
    cwd: paths.checkout,
    sandbox: false,
  })
  try {
    await expect.poll(async () => (await apiData<Task>(request, `/tasks/${agent.id}`)).status, HANDED).toBe('idle')
    const channel = await createLinear(flow, name)
    await post(request, `/channels/${channel.id}/subscriptions`, { target: 'task', task_id: agent.id, delivery: 'now' })

    const forged = await linearDelivery(request, channel, 'Forged issue', 'not-the-signing-secret')
    expect(forged.status()).toBe(401)
    const good = await linearDelivery(request, channel, 'Checkout button is dead')
    expect(good.status(), await good.text()).toBe(200)

    await page.goto(`/#agents/${agent.id}`)
    await expect(page.getByRole('main').getByText('Seti started a turn to hand the agent 1 update')).toBeVisible(HANDED)

    await page.goto(`/#settings/channels/${channel.id}`)
    const card = page.getByRole('main').getByRole('region', { name })
    await expect(card).toContainText('Linear: signed with Linear-Signature')
    await press(card.getByRole('button', { name: `${name} activity` }))
    await expect(card).toContainText('Deliveries from Linear')
    const log = card.getByRole('list', { name: `${name} deliveries` }).getByRole('listitem')
    await expect(log.filter({ hasText: 'signature mismatch' })).toContainText('rejected')
    await expect(log.filter({ hasText: 'signature mismatch' })).not.toContainText('Forged issue')
    await expect(log.filter({ hasText: `Tracker agent ${tag}` })).toContainText('accepted')
    await expect(card.getByRole('list', { name: `${name} events` })).toContainText('Checkout button is dead')
    if (phone) {
      await expectFitsPhone(page, 'a Linear webhook with its deliveries')
    }
  } finally {
    await removeChannel(request, name)
  }
}

/** Fills the sample of a request and checks it, expecting the update it would make. */
async function checkSample(flow: SenderFlow, tester: Locator, body: string, title: string): Promise<void> {
  await tester
    .getByRole('textbox', { name: 'Sample headers', exact: true })
    .fill(`Content-Type: application/json\nX-Acme-Event: ticket\nX-Acme-Signature: sha256=${hex(ACME_SECRET, body)}`)
  await tester.getByRole('textbox', { name: 'Sample body', exact: true }).fill(body)
  await flow.press(tester.getByRole('button', { name: 'Check', exact: true }))
  const result = tester.getByTestId('sample-result')
  await expect(result).toContainText('Signature verifies')
  await expect(result).toContainText('ticket.opened')
  await expect(result).toContainText(title)
  await expect(result).toContainText('https://acme.example/t/7')
}

/**
 * An app Seti does not list is described in the custom form and checked with a pasted request
 * before the webhook exists, then again from its card with the stored secret.
 */
export async function customSenderChecksASample(flow: SenderFlow): Promise<void> {
  const { page, press, request, phone } = flow
  const name = `Acme ${randomUUID().slice(0, 8)}`
  const body = JSON.stringify({ action: 'opened', subject: 'Ticket 7', link: 'https://acme.example/t/7' })
  try {
    const picker = await openPicker(flow)
    await picker.getByRole('textbox', { name: 'Search senders', exact: true }).fill('no such app')
    await expect(picker).toContainText('Nothing matches. Describe the app as a custom sender.')
    await press(picker.getByRole('button', { name: 'Custom', exact: true }))

    const form = page.getByRole('dialog', { name: 'New Custom webhook' })
    await form.getByRole('textbox', { name: 'Name', exact: true }).fill(name)
    await form.getByLabel('Secret', { exact: true }).fill(ACME_SECRET)
    await form.getByRole('textbox', { name: 'Header', exact: true }).fill('X-Acme-Signature')
    await form.getByRole('textbox', { name: 'Prefix', exact: true }).fill('sha256=')
    await press(form.getByRole('combobox', { name: 'Event in', exact: true }))
    await press(page.getByRole('option', { name: 'Header', exact: true }))
    await form.getByRole('textbox', { name: 'Event name', exact: true }).fill('X-Acme-Event')
    await form.getByRole('textbox', { name: 'Action field', exact: true }).fill('action')
    await form.getByRole('textbox', { name: 'Title fields', exact: true }).fill('subject')
    await form.getByRole('textbox', { name: 'Link fields', exact: true }).fill('link')
    if (phone) {
      await expectFitsPhone(page, 'the custom sender form')
    }
    await checkSample(flow, form, body, 'Ticket 7')
    await form.getByRole('textbox', { name: 'Sample body', exact: true }).fill(`${body.slice(0, -1)},"extra":1}`)
    await press(form.getByRole('button', { name: 'Check', exact: true }))
    await expect(form.getByTestId('sample-result')).toContainText('Does not verify')
    await expect(form.getByTestId('sample-result')).toContainText('signature mismatch')
    await press(form.getByRole('button', { name: 'Create', exact: true }))

    const made = page.getByRole('dialog', { name })
    await expect(made).toContainText('Custom issued the secret, so Seti does not show it.')
    await press(made.getByRole('button', { name: 'Done', exact: true }))
    const channel = await channelNamed(request, name)
    expect(channel).toMatchObject({ preset: 'custom', sender: { signature: 'X-Acme-Signature' }, secret_pending: null })

    const card = page.getByRole('main').getByRole('region', { name })
    await expect(card).toContainText('Custom: signed with X-Acme-Signature')
    await press(card.getByRole('button', { name: 'Sample', exact: true }))
    const sample = page.getByRole('dialog', { name: `Sample for ${name}` })
    await checkSample(flow, sample, body, 'Ticket 7')
    if (phone) {
      await expectFitsPhone(page, 'the sample check of a webhook')
    }
    await press(sample.getByRole('button', { name: 'Done', exact: true }))
    await press(card.getByRole('button', { name: 'Edit', exact: true }))
    const edit = page.getByRole('dialog', { name: `Sender of ${name}` })
    await expect(edit.getByRole('textbox', { name: 'Header', exact: true })).toHaveValue('X-Acme-Signature')
    await edit.getByRole('textbox', { name: 'Header', exact: true }).fill('X-Acme-Sig')
    await press(edit.getByRole('button', { name: 'Save', exact: true }))
    await expect(card).toContainText('Custom: signed with X-Acme-Sig')
    expect((await channelNamed(request, name)).deliveries).toEqual([])
  } finally {
    await removeChannel(request, name)
  }
}
