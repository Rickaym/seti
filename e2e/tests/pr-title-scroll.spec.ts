import { randomUUID } from 'node:crypto'
import type { Locator, Page } from '@playwright/test'
import type { PrList, PullRequest } from '@seti/shared'
import { openSeedDb } from './support/db.js'
import { paths } from './support/env.js'
import { expect, test } from './support/fixtures.js'

const SLUG = 'e2e/scroll'
const LONG = 'Make the pull request title scroll sideways while hovered so the end of a long name shows'
const SHORT = 'Fix typo'

/** Past the pause before the scroll starts, so a title that would move has begun to. */
const PAST_PAUSE_MS = 1500

function pr(number: number, title: string): PullRequest {
  return {
    key: `scroll-${String(number)}`,
    repo_id: SLUG,
    repo_slug: SLUG,
    number,
    title,
    url: `https://github.com/${SLUG}/pull/${String(number)}`,
    draft: false,
    author: 'e2e',
    head_ref: `feat/scroll-${String(number)}`,
    base_ref: 'main',
    head_oid: 'abc1234def',
    updated_at: '2026-10-03T01:00:00Z',
    review_decision: null,
    mergeable: 'mergeable',
    labels: [],
    ci: 'success',
    checks: [],
    unresolved_threads: 0,
    preview: { state: 'none', url: null, commit: null, stale: false },
    preview_host: null,
    tasks: [],
    related: [],
  }
}

const LIST: PrList = {
  viewer: 'e2e',
  scope: 'all',
  repos: [{ repo_id: SLUG, slug: SLUG, error: null, previews: false, prs: [pr(1, SHORT), pr(2, LONG)] }],
  previews_on: true,
}

async function openPicker(page: Page): Promise<{ id: string; picker: Locator }> {
  await page.route(/\/api\/prs\?scope=all$/, async (route) => route.fulfill({ json: { data: LIST, meta: {} } }))
  const db = openSeedDb()
  const id = randomUUID()
  await db.idleTask(id, 'E2E scrolling PR titles', paths.checkout, new Date().toISOString())
  await db.close()
  await page.goto(`/#agents/${id}`)
  await page.getByRole('main').getByRole('button', { name: 'Link PR' }).click()
  const picker = page.getByRole('dialog')
  await expect(picker.getByRole('button', { name: LONG })).toBeVisible()
  return { id, picker }
}

const line = (row: Locator) => row.locator('[data-slot="scroll-on-hover"] > span')

/** How far the title is shifted sideways, 0 when it rests. */
const shift = async (row: Locator) =>
  line(row).evaluate((el) => new DOMMatrixReadOnly(getComputedStyle(el).transform).m41)

test('hovering an overflowing PR title scrolls it to the end and back; a short one holds still', async ({ page }) => {
  const { id, picker } = await openPicker(page)
  const long = picker.getByRole('button', { name: LONG })
  const short = picker.getByRole('button', { name: SHORT })
  await expect(long.locator('[data-slot="scroll-on-hover"]')).toHaveAttribute('data-overflow', '')
  await expect(short.locator('[data-slot="scroll-on-hover"]')).not.toHaveAttribute('data-overflow')

  await picker.getByLabel('Search pull requests').focus()
  await page.keyboard.press('Tab')
  await expect(short).toBeFocused()
  const before = await long.boundingBox()
  await long.hover()
  await expect.poll(async () => shift(long)).toBeLessThan(-10)
  expect(await shift(short)).toBe(0)
  await expect(line(short)).toHaveCSS('transform', 'none')
  expect((await long.boundingBox())?.height).toBe(before?.height)

  await page.mouse.move(0, 0)
  await expect(line(long)).toHaveCSS('transform', 'none')
  await page.request.delete(`/api/tasks/${id}`)
})

test('with reduced motion an overflowing PR title holds still and keeps its tooltip', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const { id, picker } = await openPicker(page)
  const long = picker.getByRole('button', { name: LONG })
  await expect(long.locator('[data-slot="scroll-on-hover"]')).toHaveAttribute('title', LONG)
  await long.hover()
  await page.evaluate(async (ms) => new Promise((resolve) => setTimeout(resolve, ms)), PAST_PAUSE_MS)
  await expect(line(long)).toHaveCSS('transform', 'none')
  await page.request.delete(`/api/tasks/${id}`)
})
