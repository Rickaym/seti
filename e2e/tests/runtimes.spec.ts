import type { Page } from '@playwright/test'
import { codexRegistry } from './support/codex-registry.js'
import { codexKey, codexOff, codexStandIn, PINNED_CODEX } from './support/codex.js'
import { expect, test } from './support/fixtures.js'

const card = (page: Page) => page.getByRole('main').getByRole('region', { name: 'Codex' })
const SPARE_KEY = 'e2e_openai_spare'

/** A connection with an OpenAI key in no credential, as one the user added but did not bundle. */
async function spareKey(page: Page, add: boolean): Promise<void> {
  const listed = (await (await page.request.get('/api/connections')).json()) as { data: { id: string; name: string }[] }
  for (const each of listed.data.filter((connection) => connection.name === SPARE_KEY)) {
    await page.request.delete(`/api/connections/${each.id}`)
  }
  if (add) {
    const data = {
      name: SPARE_KEY,
      kind: 'key',
      env: 'E2E_OPENAI_SPARE',
      hosts: ['api.openai.com'],
      header: { name: 'Authorization', template: 'Bearer {{value}}' },
      values: { value: 'e2e-not-a-key' },
      profile_ids: [],
    }
    expect((await page.request.post('/api/connections', { data })).ok()).toBe(true)
  }
}

test('turning Codex on installs it, shows a failure with Retry, and reads Ready with a key', async ({
  page,
  request,
}) => {
  const registry = codexRegistry()
  await codexOff(request)
  try {
    await page.goto('/#settings/runtimes')
    await expect(card(page).getByRole('status')).toHaveText('Off')
    const toggle = card(page).getByRole('button', { name: 'Codex', exact: true })
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await expect(card(page).getByText('OpenAI key')).toHaveCount(0)
    await expect(card(page).getByRole('textbox', { name: 'Own program' })).toHaveCount(0)

    registry.mode = 'corrupt'
    await toggle.click()
    await expect(card(page).getByRole('status')).toHaveText('Failed')
    await expect(card(page)).toContainText('Checksum mismatch')
    await expect(card(page)).toContainText('fails its pinned sha512')

    registry.mode = 'hold'
    await card(page).getByRole('button', { name: 'Retry' }).click()
    await expect(card(page).getByRole('status')).toHaveText('Installing')
    await expect(card(page)).toContainText(`Codex ${PINNED_CODEX} from the npm registry`)
    registry.release()
    await expect(card(page).getByRole('status')).toHaveText('No key')
    await expect(card(page)).toContainText('New agents get none yet: add your OpenAI key in Connections')

    await spareKey(page, true)
    await page.reload()
    await expect(card(page)).toContainText(`Your connection ${SPARE_KEY} holds a key but is not in the default`)
    await codexKey(request)
    await page.reload()
    await expect(card(page).getByRole('status')).toHaveText('Ready')
    await expect(card(page)).toContainText('New agents get the key in the default credential.')
    await expect(card(page).getByRole('button', { name: 'Rules' })).toHaveAttribute('aria-pressed', 'false')

    await card(page)
      .getByRole('button', { name: /Advanced/ })
      .click()
    await card(page).getByRole('combobox', { name: 'Default effort' }).selectOption('high')
    await expect(card(page).getByRole('combobox', { name: 'Default effort' })).toHaveValue('high')
    await expect(card(page)).toContainText(/prices as of \d{4}-\d{2}-\d{2}/)
  } finally {
    await spareKey(page, false)
    await codexOff(request)
  }
})

test('a program of your own under Advanced stands in for the copy Seti installs', async ({ page, request }) => {
  const registry = codexRegistry()
  await codexOff(request)
  try {
    await page.goto('/#settings/runtimes')
    await card(page)
      .getByRole('button', { name: /Advanced/ })
      .click()
    const own = card(page).getByRole('textbox', { name: 'Own program' })
    await own.fill('/nowhere/codex')
    await card(page).getByRole('button', { name: 'Save' }).click()
    await expect(card(page).getByRole('button', { name: /Advanced/ })).toContainText('Own program')
    const asked = registry.asked
    await card(page).getByRole('button', { name: 'Codex', exact: true }).click()
    await expect(card(page).getByRole('status')).toHaveText('Failed')
    await expect(card(page)).toContainText('The program you named, /nowhere/codex, is not there')

    await own.fill(codexStandIn('0.1.0'))
    await card(page).getByRole('button', { name: 'Save' }).click()
    await expect(card(page)).toContainText(`reports 0.1.0; this Seti needs ${PINNED_CODEX}`)
    await own.fill(codexStandIn(PINNED_CODEX))
    await card(page).getByRole('button', { name: 'Save' }).click()
    await expect(card(page).getByRole('status')).toHaveText('No key')
    expect(registry.asked, 'nothing is fetched for a program of your own').toBe(asked)

    await card(page).getByRole('button', { name: 'Connections' }).click()
    await expect(page).toHaveURL(/#settings\/connections/)
  } finally {
    await codexOff(request)
  }
})
