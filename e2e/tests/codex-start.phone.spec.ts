import { codexOff, codexReady } from './support/codex.js'
import { expect, test } from './support/fixtures.js'
import { expectFitsPhone, expectTouchTarget } from './support/phone-layout.js'

test('a phone picks a Codex model for a new agent with touch-sized selects', async ({ page, request }) => {
  await codexOff(request)
  try {
    await page.goto('/#agents')
    const main = page.getByRole('main')
    await main.getByRole('button', { name: 'New agent' }).tap()
    await expect(main.getByLabel('Message')).toBeVisible()
    await expect(main.getByRole('combobox', { name: 'Model' })).toHaveCount(0)

    await codexReady(request)
    await page.reload()
    const model = main.getByRole('combobox', { name: 'Model' })
    await expect(model).toHaveValue('claude:')
    await expectTouchTarget(model, 'model select')
    await expectFitsPhone(page, 'start page with the model selector')

    await model.selectOption({ label: 'gpt-5.5' })
    const effort = main.getByRole('combobox', { name: 'Effort' })
    await expectTouchTarget(effort, 'effort select')
    await expect(main.getByRole('button', { name: 'Sandbox', exact: true })).toHaveCount(0)
    await expectFitsPhone(page, 'start page with a Codex model picked')
  } finally {
    await codexOff(request)
  }
})
