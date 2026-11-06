import { expect, test } from './support/fixtures.js'
import { fileRow, SETI_WRITTEN, seedNestedAgent } from './support/seti-files.js'
import { filesPanel } from './support/viewer-files.js'

test('recent files hide what Seti writes until asked, remember it, and show each file once', async ({ page }) => {
  const { id } = await seedNestedAgent()
  await page.goto(`/#agents/${id}`)
  await page.getByRole('button', { name: 'Files', exact: true }).click()
  const panel = filesPanel(page)
  const list = panel.getByRole('list', { name: 'Files' })
  await expect(list.getByRole('button', { name: fileRow('ops.log') })).toHaveCount(1)
  await expect(list.getByRole('button', { name: fileRow('report.md') })).toHaveCount(1)
  for (const name of SETI_WRITTEN) {
    await expect(list.getByRole('button', { name: fileRow(name) })).toHaveCount(0)
  }

  const toggle = panel.getByRole('button', { name: 'Seti files' })
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  for (const name of SETI_WRITTEN) {
    await expect(list.getByRole('button', { name: fileRow(name) })).toHaveCount(1)
  }
  await expect(list.getByRole('button', { name: fileRow('ops.log') })).toHaveCount(1)

  await page.reload()
  await page.getByRole('button', { name: 'Files', exact: true }).click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect(list.getByRole('button', { name: fileRow('members.md') })).toHaveCount(1)

  await toggle.click()
  await expect(list.getByRole('button', { name: fileRow('members.md') })).toHaveCount(0)
  await panel.getByRole('combobox', { name: 'Root' }).selectOption({ label: 'Workspace' })
  await expect(list.getByRole('button', { name: fileRow('report.md') })).toBeVisible()
  await expect(list.getByRole('button', { name: fileRow('task.md') })).toHaveCount(0)
})
