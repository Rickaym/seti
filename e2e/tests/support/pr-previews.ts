import { randomUUID } from 'node:crypto'
import { type APIRequestContext, type Locator, type Page, expect } from '@playwright/test'
import { openSeedDb } from './db.js'
import { paths } from './env.js'
import { setFakeGh } from './fake-gh-env.js'
import { setModEnabled } from './mods.js'

const READY_COMMENT = `## Preview Environment Ready

**Preview URL:** https://pr-1.preview.invalid

| Detail | Value |
|--------|-------|
| Commit | \`abc1234\` |`

/** An open PR node as the repo PR list query reads it, with the Actions bot's Ready comment. */
function openPrNode(slug: string, number: number) {
  return {
    number,
    title: 'Preview me',
    body: '',
    url: `https://github.com/${slug}/pull/${String(number)}`,
    isDraft: false,
    headRefName: 'feat/preview',
    baseRefName: 'main',
    headRefOid: 'abc1234def',
    updatedAt: '2026-11-01T00:00:00Z',
    reviewDecision: null,
    mergeable: 'MERGEABLE',
    author: { login: 'e2e' },
    labels: { nodes: [{ name: 'preview' }] },
    commits: { nodes: [] },
    comments: {
      nodes: [{ author: { login: 'github-actions' }, body: READY_COMMENT, updatedAt: '2026-11-01T00:00:00Z' }],
    },
    reviewThreads: { nodes: [] },
  }
}

/** An idle agent linked to an open PR of a registered repo whose preview is up. */
export async function seedPreviewAgent(repo: string): Promise<{ id: string; host: string; label: string }> {
  const slug = `e2e/${repo}`
  setFakeGh('e2e', {}, { [slug]: [openPrNode(slug, 1)] })
  const db = openSeedDb()
  const id = randomUUID()
  const ts = new Date().toISOString()
  await db.run(
    `INSERT INTO repo (id, slug, path, base_branch, created_at) VALUES (?, ?, ?, 'main', ?)`,
    slug,
    slug,
    paths.checkout,
    ts,
  )
  await db.run(
    `INSERT INTO task (id, title, repo_id, cwd, worktree, status, created_at, updated_at)
     VALUES (?, ?, NULL, ?, 0, 'idle', ?, ?)`,
    id,
    `E2E preview ${repo}`,
    paths.checkout,
    ts,
    ts,
  )
  await db.run(
    `INSERT INTO task_pr (task_id, pr_url, linked_at, source) VALUES (?, ?, ?, 'user')`,
    id,
    `https://github.com/${slug}/pull/1`,
    ts,
  )
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
