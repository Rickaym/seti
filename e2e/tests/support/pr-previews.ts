import { randomUUID } from 'node:crypto'
import { type APIRequestContext, type Locator, type Page, expect } from '@playwright/test'
import { openSeedDb } from './db.js'
import { paths } from './env.js'
import { prNode, setFakeGh } from './fake-gh-env.js'
import { setModEnabled } from './mods.js'

const READY_COMMENT = `## Preview Environment Ready

**Preview URL:** https://pr-1.preview.invalid

| Detail | Value |
|--------|-------|
| Commit | \`abc1234\` |`

/** An idle agent linked to an open PR whose preview is up, in a repo Seti has no checkout of. */
export async function seedPreviewAgent(repo: string): Promise<{ id: string; host: string; label: string }> {
  const url = `https://github.com/e2e/${repo}/pull/1`
  const ready = { id: '1', login: 'github-actions', body: READY_COMMENT, created_at: '2026-11-01T00:00:00Z' }
  setFakeGh('e2e', { [url]: { ...prNode(url, 'OPEN', [ready]), labels: { nodes: [{ name: 'preview' }] } } })
  const db = openSeedDb()
  const id = randomUUID()
  const ts = new Date().toISOString()
  await db.idleTask(id, `E2E preview ${repo}`, paths.checkout, ts)
  await db.run(`INSERT INTO task_pr (task_id, pr_url, linked_at, source) VALUES (?, ?, ?, 'user')`, id, url, ts)
  await db.close()
  return { id, host: `${repo}-pr-1.seti.localhost`, label: `${repo}#1` }
}

/** The preview chip's link beside the PR in the agent's PR row. */
export const previewLink = (page: Page, label: string): Locator =>
  page
    .getByRole('main')
    .getByRole('group', { name: `Pull request ${label}` })
    .getByRole('link', { name: 'preview', exact: true })

/** Seti's status on a preview host: 502 while it proxies to the unreachable upstream, else 404. */
export async function previewHostStatus(request: APIRequestContext, baseURL: string, host: string) {
  const response = await request.get(`${baseURL}/`, { headers: { host: `${host}:${new URL(baseURL).port}` } })
  return response.status()
}

/** Turns the PR previews mod on or off and reloads the agent page. */
export async function setPreviews(page: Page, request: APIRequestContext, on: boolean): Promise<void> {
  await setModEnabled(request, 'pr-previews', on)
  await page.reload()
  await expect(page.getByRole('main')).toBeVisible()
}
