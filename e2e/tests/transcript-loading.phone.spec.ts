import { expect, test, unique } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'
import { seedLoadingTask, stream } from './support/transcript-loading.js'

test('the transcript skeleton fits a phone under the agent header', async ({ page }) => {
  const title = unique('Phone slow transcript')
  const { id, reply } = await seedLoadingTask(title)
  let release: () => void = () => undefined
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route(stream(id), async (route) => {
    await held
    await route.continue()
  })
  await page.goto(`/#agents/${id}`)
  const main = page.getByRole('main')
  await expect(main.getByRole('heading', { name: title })).toBeVisible()
  const skeleton = page.getByRole('status', { name: 'Loading transcript' })
  await expect(skeleton).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Reply' })).toBeVisible()
  await expectFitsPhone(page, 'transcript skeleton')

  release()
  await expect(page.getByRole('region', { name: 'Transcript' }).getByText(reply)).toBeVisible()
  await expect(skeleton).toHaveCount(0)
})
