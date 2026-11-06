import { expect, test } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'
import { fileRow, seedNestedAgent } from './support/seti-files.js'
import { filesPanel } from './support/viewer-files.js'

test('the files sheet hides what Seti writes behind a touch-size toggle', async ({ page }) => {
  const { id } = await seedNestedAgent()
  await page.goto(`/#agents/${id}`)
  await page.getByRole('main').getByRole('button', { name: 'More actions' }).tap()
  await page.getByRole('dialog', { name: 'Agent actions' }).getByRole('button', { name: 'Files' }).tap()
  const panel = filesPanel(page)
  const list = panel.getByRole('list', { name: 'Files' })
  await expect(list.getByRole('button', { name: fileRow('ops.log') })).toHaveCount(1)
  await expect(list.getByRole('button', { name: fileRow('members.md') })).toHaveCount(0)

  const toggle = panel.getByRole('button', { name: 'Seti files' })
  expect((await toggle.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
  await expectFitsPhone(page, 'the files sheet toolbar')
  await toggle.tap()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect(list.getByRole('button', { name: fileRow('members.md') })).toHaveCount(1)
  await expect(list.getByRole('button', { name: fileRow('ops.log') })).toHaveCount(1)
})
