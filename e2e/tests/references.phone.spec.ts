import { expect, test, unique } from './support/fixtures.js'
import { expectFitsPhone, expectTouchTarget, settled } from './support/phone-layout.js'
import {
  bareReply,
  markOf,
  QUOTE,
  referencedReply,
  seedBareLinks,
  seedReferences,
  SLACK_FILE,
  SOURCES,
} from './support/references.js'

test('on a phone the Sources list folds to one line and opens on a tap', async ({ page }) => {
  const id = await seedReferences(unique('Phone references'))
  await page.goto(`/#agents/${id}`)
  const reply = referencedReply(page)
  const sources = reply.getByRole('region', { name: 'Sources' })
  const fold = sources.getByRole('button', { name: '5 sources' })
  await expect(fold).toBeVisible()
  await expect(sources.locator('[data-source]')).toHaveCount(0)
  await expectTouchTarget(fold, 'Sources fold')
  await expectTouchTarget(markOf(page, 1), 'reference mark')
  await expectFitsPhone(page, 'a reply with references')
  await reply.getByTestId('quote-source').scrollIntoViewIfNeeded()
  await page.screenshot({ path: test.info().outputPath('references-phone-light.png') })

  await fold.tap()
  await expect(sources.locator('[data-source]')).toHaveCount(5)
  await expectTouchTarget(sources.locator('[data-source="1"] a'), 'source row')
  await expectFitsPhone(page, 'an open Sources list')
  await page.emulateMedia({ colorScheme: 'dark' })
  await settled(page)
  await sources.scrollIntoViewIfNeeded()
  await page.screenshot({ path: test.info().outputPath('references-phone-dark.png') })
  await page.emulateMedia({ colorScheme: 'light' })
})

test('tapping a mark opens a sheet with the source and an Open button, and stays in the chat', async ({ page }) => {
  const id = await seedReferences(unique('Phone reference sheet'))
  await page.goto(`/#agents/${id}`)
  const at = page.url()

  await markOf(page, 2).tap()
  const sheet = page.getByTestId('reference-sheet')
  await expect(sheet).toContainText(SOURCES.slack.label)
  await expect(sheet).toContainText(QUOTE)
  const open = sheet.getByRole('link', { name: 'Open' })
  await expect(open).toHaveAttribute('href', SOURCES.slack.url)
  await expect(open).toHaveAttribute('target', '_blank')
  await expectTouchTarget(open, 'Open button')
  await page.screenshot({ path: test.info().outputPath('reference-sheet-phone.png') })
  expect(page.url()).toBe(at)

  await page.keyboard.press('Escape')
  await expect(sheet).toBeHidden()
  await markOf(page, 4).tap()
  await expect(page.getByTestId('reference-sheet')).toContainText(SOURCES.note)
  await expect(page.getByTestId('reference-sheet').getByRole('link', { name: 'Open' })).toHaveCount(0)
  expect(page.url()).toBe(at)
})

test('on a phone a bare URL reads as a short name with its mark and fits the screen', async ({ page }) => {
  const id = await seedBareLinks(unique('Phone bare links'))
  await page.goto(`/#agents/${id}`)
  const reply = bareReply(page)
  await expect(reply.locator('[data-reference]').first()).toBeVisible()
  await settled(page)
  await page.screenshot({ path: test.info().outputPath('bare-links-phone.png') })

  await expect(reply.getByRole('link', { name: SLACK_FILE.label, exact: true })).toHaveAttribute('href', SLACK_FILE.url)
  await expect(reply.getByRole('link', { name: 'example.com', exact: true })).toBeVisible()
  await expectFitsPhone(page, 'a reply with bare URLs')
  await reply.getByRole('button', { name: '4 sources' }).tap()
  await expect(reply.locator('[data-source="1"]')).toContainText(SLACK_FILE.label)
  await expect(reply.locator('[data-source="1"] a')).toHaveAttribute('href', SLACK_FILE.url)
})
