import type { Page } from '@playwright/test'
import { codexKey, codexOff, codexStandIn, PINNED_CODEX } from './support/codex.js'
import { expect, test } from './support/fixtures.js'

const card = (page: Page) => page.getByRole('main').getByRole('region', { name: 'Codex' })

async function saveProgram(page: Page, program: string) {
  await card(page).getByRole('textbox', { name: 'Program' }).fill(program)
  await card(page).getByRole('button', { name: 'Save' }).click()
}

test('Codex starts off and reaches Ready once on with the pinned program and a key', async ({ page, request }) => {
  await codexOff(request)
  try {
    await page.goto('/#settings/runtimes')
    await expect(card(page).getByRole('status')).toHaveText('Off')
    await expect(card(page).getByRole('button', { name: 'Codex', exact: true })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    await expect(card(page)).toContainText(`version ${PINNED_CODEX}; none found`)
    await expect(card(page)).toContainText('Add it in Connections: a connection with a header on api.openai.com')
    await expect(card(page)).toContainText(/Prices as of \d{4}-\d{2}-\d{2}/)

    await card(page).getByRole('button', { name: 'Codex', exact: true }).click()
    await expect(card(page).getByRole('status')).toHaveText('Not set up')

    await saveProgram(page, '/nowhere/codex')
    await expect(card(page).getByRole('status')).toHaveText('Missing')

    await saveProgram(page, codexStandIn('0.1.0'))
    await expect(card(page).getByRole('status')).toHaveText('Update needed')
    await expect(card(page)).toContainText('found 0.1.0')

    await saveProgram(page, codexStandIn(PINNED_CODEX))
    await expect(card(page).getByRole('status')).toHaveText('No key')

    await codexKey(request)
    await page.reload()
    await expect(card(page).getByRole('status')).toHaveText('Ready')
    await expect(card(page)).toContainText('The default credential holds one')

    await card(page).getByRole('combobox', { name: 'Default effort' }).selectOption('high')
    await expect(card(page).getByRole('combobox', { name: 'Default effort' })).toHaveValue('high')
    const rules = card(page).getByRole('button', { name: 'Rules' })
    await expect(rules).toHaveAttribute('aria-pressed', 'false')

    await card(page).getByRole('button', { name: 'Connections' }).click()
    await expect(page).toHaveURL(/#settings\/connections/)
  } finally {
    await codexOff(request)
  }
})
