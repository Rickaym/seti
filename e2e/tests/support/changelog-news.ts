import type { APIRequestContext } from '@playwright/test'
import type { Changelog, ChangelogStatus } from '@seti/shared'
import { apiData, expect } from './fixtures.js'

/** Marks the changelog seen at the workspaces commit, so the three changes after it are news. */
export async function seeChangelogBefore(request: APIRequestContext): Promise<void> {
  const log = await apiData<Changelog>(request, '/mods/whats-new/changelog')
  const entry = log.entries.find((candidate) => candidate.description === 'workspaces')
  expect(entry, 'the workspaces entry').toBeDefined()
  const response = await request.post('/api/mods/whats-new/seen', { data: { commit: entry?.commit } })
  expect(response.ok(), 'POST /api/mods/whats-new/seen').toBe(true)
  await expect.poll(async () => (await apiData<ChangelogStatus>(request, '/mods/whats-new/status')).unseen).toBe(3)
}
