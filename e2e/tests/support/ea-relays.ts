import { randomUUID } from 'node:crypto'
import type { APIRequestContext } from '@playwright/test'
import type { EaFollowup, EaHealth, EaInboxItem, EaRelay } from '@seti/shared'
import { openSeedDb } from './db.js'
import { EA_HEADERS, paths } from './env.js'
import { expect } from './fixtures.js'

export const READY: EaHealth = {
  ok: true,
  configured: true,
  missing: [],
  model: 'gpt-4.1-mini',
  text_model: 'gpt-4.1',
  chat_missing: [],
  turn: true,
}

export const TOLD = 'Assigned Release notes: the QA lead wants to know if 4.2 is ready; it drafts an answer for you.'

async function asBot<T>(request: APIRequestContext, url: string, data: unknown): Promise<T> {
  const response = await request.post(url, { headers: EA_HEADERS, data })
  expect(response.ok(), `${url}: ${await response.text()}`).toBe(true)
  return ((await response.json()) as { data: T }).data
}

/** Sets the Assign switch and clears what the EA was told to skip, so each test starts the same. */
export async function setRelays(request: APIRequestContext, on: boolean): Promise<void> {
  expect((await request.put('/api/ea/settings/inbox-relays', { data: { on } })).ok()).toBe(true)
  const db = openSeedDb()
  await db.run('DELETE FROM ea_assign_skip')
  await db.close()
}

/** A muted agent's follow-up, delivered and relayed; the relay waits, so Take back stays open. */
export async function relayedItem(request: APIRequestContext, title = 'Release notes'): Promise<EaRelay> {
  const db = openSeedDb()
  const taskId = randomUUID()
  await db.idleTask(taskId, title, paths.root, new Date().toISOString())
  await db.close()
  expect((await request.patch(`/api/team/members/${taskId}`, { data: { muted: true } })).ok()).toBe(true)
  await setRelays(request, true)
  const item = await asBot<EaFollowup>(request, '/api/ea/followups', {
    when: 'in 1 second',
    note: 'Check whether 4.2 is ready for QA',
    timezone: 'Europe/Berlin',
    task_id: taskId,
  })
  await expect
    .poll(async () => {
      const due = await request.get('/api/ea/inbox/due', { headers: EA_HEADERS })
      return ((await due.json()) as { data: EaInboxItem[] }).data.map((waiting) => waiting.id)
    })
    .toContain(item.id)
  await asBot(request, '/api/ea/inbox/deliver', { ids: [item.id], via: 'chat' })
  const relay = await asBot<EaRelay>(request, '/api/ea/relays', {
    item_id: item.id,
    to: taskId,
    text: 'The QA lead asks whether 4.2 is ready; draft an answer for the user and do not send it.',
  })
  await asBot(request, '/api/ea/history/messages', {
    entries: [{ kind: 'chat', message: { role: 'assistant', content: TOLD } }],
  })
  return relay
}

/** A relay shown as the EA starting its agent, as it does for an item from a channel set to act. */
export async function startedItem(request: APIRequestContext, title = 'BES latency'): Promise<EaRelay> {
  const relay = await relayedItem(request, title)
  const db = openSeedDb()
  await db.run('UPDATE ea_relay SET started = true, message_id = NULL WHERE id = ?', relay.id)
  await db.run("UPDATE task SET status = 'running' WHERE id = ?", relay.task_id)
  await db.close()
  return relay
}

/** Tells the EA to stop assigning to an agent, as the EA does when the user says so. */
export async function skipAgent(request: APIRequestContext, title: string): Promise<void> {
  const db = openSeedDb()
  const taskId = randomUUID()
  await db.idleTask(taskId, title, paths.root, new Date().toISOString())
  await db.close()
  await asBot(request, '/api/ea/assign-skips', { kind: 'agent', ref: taskId })
}
