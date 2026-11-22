import type { Locator, Page } from '@playwright/test'
import { expect, test, unique } from './support/fixtures.js'
import { LINKS, seedLinkPills } from './support/link-pills.js'

const transcript = (page: Page) => page.getByRole('region', { name: 'Transcript' })

/** Copies the element's whole text as a selection copy would, and returns the plain text. */
const copiedText = async (element: Locator) =>
  element.evaluate((el) => {
    const range = document.createRange()
    range.selectNodeContents(el)
    const selection = document.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    const event = new ClipboardEvent('copy', { clipboardData: new DataTransfer(), bubbles: true, cancelable: true })
    el.dispatchEvent(event)
    return event.clipboardData?.getData('text/plain') ?? ''
  })

test('an agent reply shows its Slack, GitHub and plain links as named pills', async ({ page }) => {
  const id = await seedLinkPills(unique('Link pills'))
  await page.goto(`/#agents/${id}`)
  const pane = transcript(page)
  const reply = pane.locator('[data-find-text]').filter({ hasText: 'Setup steps are in' })

  const slack = reply.getByRole('link', { name: LINKS.slack.label })
  const pr = reply.getByRole('link', { name: LINKS.pr.label })
  const plain = reply.getByRole('link', { name: LINKS.plain.label })
  await expect(slack).toHaveAttribute('href', LINKS.slack.url)
  await expect(slack).toHaveAttribute('data-link-pill', 'slack')
  await expect(pr).toHaveAttribute('href', LINKS.pr.url)
  await expect(pr).toHaveAttribute('data-link-pill', 'github')
  await expect(pr.locator('svg[data-service-icon="github"]')).toHaveCount(1)
  await expect(plain).toHaveAttribute('href', LINKS.plain.url)
  await expect(plain).toHaveAttribute('data-link-pill', 'web')
  await expect(reply.getByRole('link', { name: LINKS.issue.label })).toHaveAttribute('data-link-pill', 'linear')
  for (const pill of [slack, pr, plain]) {
    await expect(pill).toHaveAttribute('target', '_blank')
    await expect(pill).toHaveAttribute('rel', 'noreferrer')
  }

  await pr.hover()
  await expect(page.getByRole('tooltip')).toContainText(LINKS.pr.url)

  const labelled = reply.getByRole('link', { name: 'the changelog' })
  await expect(labelled).toHaveAttribute('href', LINKS.labelled)
  await expect(labelled).not.toHaveAttribute('data-link-pill')
  await expect(reply.locator('p code', { hasText: LINKS.code })).toHaveCount(1)
  await expect(reply.locator('pre', { hasText: `curl ${LINKS.code}` })).toHaveCount(1)
  await expect(reply.locator('code [data-link-pill], pre [data-link-pill]')).toHaveCount(0)
})

test('copying a reply copies the URLs of its pills, not their labels', async ({ page }) => {
  const id = await seedLinkPills(unique('Link pills copy'))
  await page.goto(`/#agents/${id}`)
  const pane = transcript(page)
  const first = pane.locator('p', { has: page.locator('[data-link-pill="github"]') })
  await expect(first).toBeVisible()
  const text = await copiedText(first)
  expect(text).toContain(LINKS.slack.url)
  expect(text).toContain(LINKS.pr.url)
  expect(text).not.toContain(LINKS.slack.label)
  expect(text).not.toContain(LINKS.pr.label)
})

test("the user's own message shows its link as a pill", async ({ page }) => {
  const id = await seedLinkPills(unique('Link pills prompt'))
  await page.goto(`/#agents/${id}`)
  const own = transcript(page).locator('[data-own-message]')
  await expect(own.getByRole('link', { name: LINKS.slack.label })).toHaveAttribute('href', LINKS.slack.url)
})
