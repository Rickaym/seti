import { expect, test } from './support/fixtures.js'
import { cleanUpMod, openModsInDevMode, writeModPackage } from './support/mod-packages.js'

const ID = 'tracker'

test.afterEach(async ({ request }) => {
  await cleanUpMod(request, ID)
})

test('installs a folder mod from its preview page after consent, updates it and uninstalls it', async ({ page }) => {
  const folder = writeModPackage(ID, ['api.tracker.example'])
  await openModsInDevMode(page)
  const main = page.getByRole('main')
  await main.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(page).toHaveURL(/#settings\/mods\/add$/)
  await expect(main.getByRole('heading', { name: 'Add a mod', level: 2 })).toBeVisible()
  await main.getByRole('textbox', { name: 'Folder' }).fill(folder)
  await main.getByRole('textbox', { name: 'Folder' }).press('Enter')
  const check = main.getByRole('region', { name: 'Check' })
  const can = check.getByRole('list', { name: 'What Tracker can do' })
  await expect(can).toContainText('Sends and receives data with api.tracker.example. It can send what it reads there.')
  await expect(can).toContainText('Keeps up to 1 MB of its own data in Seti.')
  await expect(check).toContainText('by Someone (unverified)')
  await expect(check).toContainText('Shows how a third-party mod installs.')
  await expect(check.locator('img[src^="data:image/svg+xml;base64,"]')).toHaveCount(1)
  await check.getByRole('tab', { name: 'Details' }).click()
  await expect(check.getByText('tracker', { exact: true })).toBeVisible()
  await check.getByRole('tab', { name: 'Contributes' }).click()
  await expect(check).toContainText('It adds nothing beyond its settings.')
  await check.getByRole('button', { name: 'Install' }).click()

  await expect(page).toHaveURL(/#settings\/mods\/tracker$/)
  await expect(main.getByRole('heading', { name: 'Tracker', level: 2 })).toBeVisible()
  await expect(main.getByRole('button', { name: 'On', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(main.getByRole('definition').filter({ hasText: /^sha256:[a-f0-9]{12}$/ })).toHaveCount(1)
  await expect(main.getByRole('link', { name: 'Homepage' })).toHaveAttribute('href', 'https://example.com/mods')

  writeModPackage(ID, ['api.tracker.example', 'upload.tracker.example'], folder)
  await main.getByRole('tab', { name: 'Versions' }).click()
  await expect(page).toHaveURL(/#settings\/mods\/tracker\/versions$/)
  await main.getByRole('button', { name: 'Check' }).click()
  const pending = main.getByRole('region', { name: 'Pending update' })
  await expect(pending).toContainText('1.1.0 asks for more and waits for you.')
  await expect(pending).toContainText('Now also: Sends and receives data with upload.tracker.example.')
  await pending.getByRole('button', { name: 'Update now' }).click()
  await expect(pending).toHaveCount(0)
  await expect(main.getByRole('list', { name: 'Kept versions' })).toContainText('1.0.0')
  await main.getByRole('button', { name: 'Uninstall' }).click()
  const confirm = page.getByRole('dialog', { name: 'Uninstall Tracker?' })
  await expect(confirm.getByRole('button', { name: 'Delete its data' })).toHaveAttribute('aria-pressed', 'true')
  await confirm.getByRole('button', { name: 'Uninstall' }).click()
  await expect(page).toHaveURL(/#settings\/mods$/)
  await expect(main.getByRole('region', { name: 'Mods' })).not.toContainText('Tracker')
})

test('the list shows an installed mod with its icon and badges, and an update before it applies', async ({ page }) => {
  const folder = writeModPackage(ID, ['api.tracker.example'])
  await openModsInDevMode(page)
  const main = page.getByRole('main')
  await main.getByRole('button', { name: 'Add', exact: true }).click()
  await main.getByRole('textbox', { name: 'Folder' }).fill(folder)
  await main.getByRole('button', { name: 'Check' }).click()
  await main.getByRole('region', { name: 'Check' }).getByRole('button', { name: 'Install' }).click()
  await expect(page).toHaveURL(/#settings\/mods\/tracker$/)
  await main.getByRole('button', { name: 'Back to mods' }).click()

  const list = main.getByRole('region', { name: 'Mods' })
  await main.getByRole('tab', { name: /^Installed/ }).click()
  const row = list.getByRole('listitem', { name: 'Tracker' })
  await expect(list.getByRole('listitem', { name: 'Weather' })).toHaveCount(0)
  await expect(row).toContainText('Shows how a third-party mod installs.')
  await expect(row).toContainText('Someone')
  await expect(row.locator('img[src^="data:image/svg+xml;base64,"]')).toHaveCount(1)
  await expect(row.getByRole('button', { name: 'Tracker', exact: true })).toHaveAttribute('aria-pressed', 'true')

  writeModPackage(ID, ['api.tracker.example', 'upload.tracker.example'], folder)
  await page.request.post(`/api/mod-admin/mods/${ID}/update/check`, { data: {} })
  await page.reload()
  await main.getByRole('tab', { name: /^Updates/ }).click()
  await expect(row.getByText('Update available')).toBeVisible()
  await row.getByRole('button', { name: 'Open Tracker' }).click()
  await expect(main.getByRole('region', { name: 'Pending update' })).toContainText(
    'Now also: Sends and receives data with upload.tracker.example.',
  )
})

test('finds a mod by bisect from the bar and restores the rest', async ({ page, request }) => {
  await request.put('/api/mod-admin/dev-mode', { data: { on: true } })
  const checked = await request.post('/api/mod-admin/preview', {
    data: { source: { kind: 'folder', path: writeModPackage(ID, ['api.tracker.example']) } },
  })
  const { data } = (await checked.json()) as { data: { hash: string } }
  expect((await request.post('/api/mod-admin/install', { data: { mod_id: ID, hash: data.hash } })).status()).toBe(200)
  await page.goto('/#settings/mods')
  await page.getByRole('main').getByRole('button', { name: 'Find culprit' }).click()
  const bar = page.getByRole('region', { name: 'Mod bisect' })
  await expect(bar).toContainText('Is the problem still there?')
  for (let step = 0; step < 6; step += 1) {
    const text = (await bar.textContent()) ?? ''
    const shown = /Step (\d+):/.exec(text)?.[1]
    if (shown === undefined) {
      break
    }
    await bar.getByRole('button', { name: 'Still there' }).click()
    await expect(bar).not.toContainText(`Step ${shown}:`)
  }
  await expect(bar).toContainText('looks like the cause')
  await bar.getByRole('button', { name: 'Turn back on' }).click()
  await expect(bar).toHaveCount(0)
})
