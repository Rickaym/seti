import { expect, test } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'
import { prompts, seedAgent, shareToSeti, shareWaits, underServiceWorker } from './support/share-target.js'

test.use({ serviceWorkers: 'allow' })

const PHOTO = { name: 'whiteboard photo.png', type: 'image/png', body: 'not really a png' }

test('a phone share picks an agent by touch and sends the files with the message', async ({ page }) => {
  const id = await seedAgent('Phone share agent')
  await underServiceWorker(page)
  await shareToSeti(page, { text: 'From the whiteboard', url: 'https://example.com/board', files: [PHOTO] })

  await expect(page.getByRole('heading', { name: 'Share' })).toBeVisible()
  const chip = page.getByRole('list', { name: 'Attachments' }).getByRole('listitem')
  await expect(chip).toContainText('whiteboard-photo.png')
  await expect(page.getByRole('combobox', { name: 'Message' })).toHaveValue(
    'From the whiteboard\nhttps://example.com/board',
  )
  await expectFitsPhone(page, 'share page')

  const agent = page.getByRole('radio', { name: /Phone share agent/ })
  expect((await agent.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
  await agent.tap()
  await expect(agent).toHaveAttribute('aria-checked', 'true')
  const send = page.getByRole('button', { name: 'Send', exact: true })
  expect((await send.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
  await send.tap()

  await page.waitForURL(new RegExp(`#agents/${id}$`))
  await expect.poll(async () => (await prompts(page, id)).length).toBe(2)
  expect((await prompts(page, id))[1]?.attachments?.map((file) => file.name)).toEqual(['whiteboard-photo.png'])
  expect(await shareWaits(page)).toBe(false)
})

test('Cancel on a phone discards the share and New agent is a finger-sized row', async ({ page }) => {
  await underServiceWorker(page)
  await shareToSeti(page, { text: 'Never mind' })
  const newAgent = page.getByRole('button', { name: 'New agent' })
  expect((await newAgent.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
  await page.getByRole('button', { name: 'Cancel' }).tap()
  await page.waitForURL(/#home$/)
  expect(await shareWaits(page)).toBe(false)
})
