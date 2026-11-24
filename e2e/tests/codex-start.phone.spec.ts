import { codexOff, codexReady } from './support/codex.js'
import { expect, test } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'

test('a phone picks Codex for a new agent with touch-sized controls', async ({ page, request }) => {
  await codexReady(request)
  try {
    await page.goto('/#agents')
    const main = page.getByRole('main')
    await main.getByRole('button', { name: 'New agent' }).tap()
    const codex = main.getByRole('button', { name: 'Codex', exact: true })
    await codex.tap()
    await expect(codex).toHaveAttribute('aria-pressed', 'true')
    const model = main.getByRole('combobox', { name: 'Model' })
    await expect(model).toHaveValue('gpt-5.5')
    const box = await model.boundingBox()
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(40)
    await expectFitsPhone(page, 'start page with Codex picked')
  } finally {
    await codexOff(request)
  }
})
