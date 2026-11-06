import { randomUUID } from 'node:crypto'
import type { APIRequestContext, Page } from '@playwright/test'
import type { AuditPage, ChangeRequest, MessagePage } from '@seti/shared'
import { openSeedDb } from './db.js'
import { EA_HEADERS, paths } from './env.js'
import { apiData, expect, unique } from './fixtures.js'

/** An idle agent that holds its updates and waits on one change, as request_change files it. */
export async function seedChangeRequest(
  change: Record<string, unknown>,
  line: string,
  reason = 'The tests download fixtures from there.',
): Promise<{ taskId: string; requestId: string; title: string }> {
  const db = openSeedDb()
  const taskId = randomUUID()
  const requestId = randomUUID()
  const title = unique('Asking agent')
  const at = new Date().toISOString()
  const expires = new Date(Date.now() + 24 * 60 * 60_000).toISOString()
  await db.idleTask(taskId, title, paths.checkout, at)
  await db.run(`UPDATE task SET input_mode = 'queue', blocked = ? WHERE id = ?`, line, taskId)
  await db.run(
    `INSERT INTO change_request (id, task_id, change, change_key, reason, profile_id, state, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, 'default', 'pending', ?, ?)`,
    requestId,
    taskId,
    JSON.stringify(change),
    JSON.stringify(change),
    reason,
    at,
    expires,
  )
  await db.close()
  return { taskId, requestId, title }
}

/**
 * Checks a key pasted on a request card never shows in the agent's transcript, the audit log or
 * the request listing, and that the EA cannot answer a key request with a key of its own.
 */
export async function expectKeyStaysSecret(
  page: Page,
  request: APIRequestContext,
  { taskId, requestId, key }: { taskId: string; requestId: string; key: string },
): Promise<void> {
  await expect(page.getByRole('main')).not.toContainText(key)
  const transcript = await apiData<MessagePage>(request, `/tasks/${taskId}/messages?limit=50`)
  const audit = await apiData<AuditPage>(request, '/audit?limit=100')
  const listing = await apiData<ChangeRequest[]>(request, `/tasks/${taskId}/change-requests`)
  for (const seen of [transcript, audit, listing]) {
    expect(JSON.stringify(seen)).not.toContain(key)
  }
  expect(audit.events.find((event) => event.kind === 'task.change_allowed')).toMatchObject({
    actor: 'user',
    detail: { request_id: requestId },
  })
  expect(audit.events.find((event) => event.kind === 'system.secret_set')).toMatchObject({
    actor: 'user',
    detail: { slot: 'value' },
  })

  const change = { kind: 'api_key', env: 'EA_PASTED_KEY', hosts: ['api.ea.example.com'] }
  const pending = await seedChangeRequest(change, 'Asks for an API key EA_PASTED_KEY')
  const eaKey = `ea-${randomUUID()}`
  const refused = await request.post(`/api/tasks/${pending.taskId}/change-requests/${pending.requestId}`, {
    headers: EA_HEADERS,
    data: { decision: 'allow', value: eaKey },
  })
  expect(refused.status()).toBe(403)
  expect(await refused.text()).not.toContain(eaKey)
  const still = await apiData<ChangeRequest[]>(request, `/tasks/${pending.taskId}/change-requests`)
  expect(still.map((entry) => entry.state)).toEqual(['pending'])
  const denied = await request.post(`/api/tasks/${pending.taskId}/change-requests/${pending.requestId}`, {
    data: { decision: 'deny' },
  })
  expect(denied.ok()).toBe(true)
}
