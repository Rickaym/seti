import { expect, test, unique } from './support/fixtures.js'
import { settled } from './support/phone-layout.js'
import { markOf, QUOTE, referencedReply, seedReferences, serveSources, SOURCES } from './support/references.js'

test('links in sentences show their text with numbered marks and a Sources list', async ({ page }) => {
  const id = await seedReferences(unique('References'))
  await page.goto(`/#agents/${id}`)
  const reply = referencedReply(page)

  await expect(reply.getByRole('link', { name: 'the release review' })).toHaveAttribute('href', SOURCES.pr.url)
  const bare = reply.getByRole('link', { name: SOURCES.slack.label, exact: true })
  await expect(bare).toHaveAttribute('href', SOURCES.slack.url)
  await expect(bare).not.toHaveAttribute('data-link-pill')
  await expect(reply.locator('[data-reference]')).toHaveText(['[1]', '[2]', '[2]', '[3]', '[4]', '[5]'])
  await expect(reply.getByRole('link', { name: SOURCES.attached.label })).toHaveAttribute('data-link-pill', 'web')
  await expect(reply.locator('code', { hasText: 'ui/src/App.tsx' })).toBeVisible()

  const sources = reply.getByRole('region', { name: 'Sources' })
  await expect(sources.locator('[data-source]')).toHaveCount(5)
  await expect(sources.locator('[data-source="1"]')).toContainText(SOURCES.pr.label)
  await expect(sources.locator('[data-source="1"]')).toContainText(SOURCES.pr.host)
  await expect(sources.locator('[data-source="4"]')).toContainText(SOURCES.note)
  await expect(sources.locator('[data-source="5"]')).toContainText(SOURCES.runbook.label)

  const caption = reply.getByTestId('quote-source')
  await expect(caption).toContainText(SOURCES.slack.label)
  await expect(caption).toContainText(SOURCES.slack.host)
  await page.screenshot({ path: test.info().outputPath('references-light.png') })
  await page.emulateMedia({ colorScheme: 'dark' })
  await settled(page)
  await page.screenshot({ path: test.info().outputPath('references-dark.png') })
  await page.emulateMedia({ colorScheme: 'light' })
})

test('hovering a mark previews its source, and a click opens it without leaving the chat', async ({ page }) => {
  const id = await seedReferences(unique('Reference preview'))
  await serveSources(page)
  await page.goto(`/#agents/${id}`)
  const at = page.url()

  await markOf(page, 2).hover()
  const card = page.getByTestId('reference-preview')
  await expect(card).toContainText(SOURCES.slack.label)
  await expect(card).toContainText(SOURCES.slack.host)
  await expect(card).toContainText(QUOTE)
  await page.screenshot({ path: test.info().outputPath('reference-preview.png') })

  const [opened] = await Promise.all([page.waitForEvent('popup'), markOf(page, 1).click()])
  await expect.poll(() => opened.url()).toBe(SOURCES.pr.url)
  await opened.close()
  expect(page.url()).toBe(at)

  await page.mouse.move(0, 0)
  await markOf(page, 4).click()
  await expect(page.getByTestId('reference-preview')).toContainText(SOURCES.note)
  expect(page.url()).toBe(at)
  await expect(page.getByRole('region', { name: 'Transcript' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Footnotes' })).toHaveCount(0)
})

test('a mark takes keyboard focus with a visible ring and shows its preview', async ({ page }) => {
  const id = await seedReferences(unique('Reference focus'))
  await page.goto(`/#agents/${id}`)
  await referencedReply(page).getByRole('link', { name: 'the release review' }).focus()
  await page.keyboard.press('Tab')
  const mark = markOf(page, 1)
  await expect(mark).toBeFocused()
  await expect(mark).toHaveCSS('outline-style', 'solid')
  await expect(page.getByTestId('reference-preview')).toContainText(SOURCES.pr.label)
})

test('finding text in the chat still finds a link by its words', async ({ page }) => {
  const id = await seedReferences(unique('Reference find'))
  await page.goto(`/#agents/${id}`)
  await expect(markOf(page, 1)).toBeVisible()
  await page.keyboard.press('Control+f')
  await page.getByTestId('chat-find-input').fill('release review')
  await expect(page.getByTestId('chat-find-count')).toHaveText('1 of 1')
  await expect(page.locator('[data-find-current]')).toContainText('the release review')
})
