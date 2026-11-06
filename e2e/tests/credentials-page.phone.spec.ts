import type { SshKey, SshStatus } from '@seti/shared'
import { apiData, expect, test } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'

const ALIAS = 'phone-bastion-with-a-long-alias.example.internal'

test.afterEach(async ({ request }) => {
  await request.delete(`/api/credentials/profiles/default/ssh-hosts/${ALIAS}`)
  const status = await apiData<SshStatus>(request, '/ssh')
  for (const host of status.hosts) {
    await request.delete(`/api/ssh/hosts/${host.alias}`)
  }
  for (const key of status.keys) {
    await request.delete(`/api/ssh/keys/${key.id}`)
  }
})

test('the credentials and ssh pages, a host and a set with ssh hosts fit a phone', async ({ page, request }) => {
  const key = (
    (await (await request.post('/api/ssh/keys', { data: { name: 'phone key with a longer name' } })).json()) as {
      data: SshKey
    }
  ).data
  await request.post('/api/ssh/hosts', {
    data: {
      alias: ALIAS,
      hostname: '203.0.113.9',
      user: 'ops',
      key_id: key.id,
      options: [{ name: 'ServerAliveInterval', value: '30' }],
    },
  })
  await request.put(`/api/credentials/profiles/default/ssh-hosts/${ALIAS}`, { data: {} })

  const main = page.getByRole('main')
  for (const [hash, title] of [
    ['credentials', 'Credentials'],
    ['ssh', 'SSH'],
  ] as const) {
    await page.goto(`/#settings/${hash}`)
    await expect(main.getByRole('heading', { name: title, level: 2, exact: true })).toBeVisible()
    await expect(main.getByRole('button', { name: 'Back to settings' })).toBeVisible()
    await expect(main.getByRole('region').first()).toBeVisible()
    await expectFitsPhone(page, title)
  }

  await main.getByRole('button', { name: 'New SSH key' }).tap()
  const newKey = page.getByRole('dialog', { name: 'New SSH key' })
  await newKey.getByLabel('Key source').selectOption('paste')
  await expect(newKey.getByLabel('Private key', { exact: true })).toBeVisible()
  await expectFitsPhone(page, 'new ssh key')
  await newKey.getByRole('button', { name: 'Cancel' }).tap()

  const row = main.getByRole('list', { name: 'SSH hosts' }).getByRole('listitem', { name: ALIAS })
  await expect(row).toContainText('In Default')
  await row.getByRole('button', { name: new RegExp(ALIAS) }).tap()
  await expect(main.getByRole('heading', { name: ALIAS, level: 2 })).toBeVisible()
  await expect(main.getByRole('region', { name: 'Connection', exact: true }).getByLabel('User')).toHaveValue('ops')
  await expectFitsPhone(page, 'ssh host')

  await page.goto('/#settings/ssh')
  await row.getByRole('button', { name: `Key ${key.name}` }).tap()
  await expect(main.getByRole('heading', { name: key.name, level: 2 })).toBeVisible()
  await expect(main.getByRole('list', { name: `Hosts using ${key.name}` })).toContainText(ALIAS)
  await expectFitsPhone(page, 'ssh key')
  await main.getByRole('button', { name: 'Rename key' }).tap()
  await main.getByLabel('New name').fill('phone key renamed')
  await main.getByLabel('New name').press('Enter')
  await expect(main.getByRole('heading', { name: 'phone key renamed', level: 2 })).toBeVisible()
  await main.getByRole('button', { name: 'Add host with this key' }).tap()
  const dialog = page.getByRole('dialog', { name: 'New SSH host' })
  await expect(dialog.getByLabel('SSH key', { exact: true })).toHaveValue(key.id)
  await dialog.getByLabel('SSH key', { exact: true }).selectOption({ label: 'New key' })
  await dialog.getByRole('switch', { name: 'Paste a private key' }).tap()
  await expect(dialog.getByLabel('Private key', { exact: true })).toBeVisible()
  await expectFitsPhone(page, 'new ssh host')
  await dialog.getByRole('button', { name: 'Cancel' }).tap()

  await page.goto('/#settings/credentials/default')
  const bundled = main.getByRole('region', { name: 'SSH hosts' })
  await expect(bundled.getByRole('switch', { name: `${ALIAS} in Default` })).toBeChecked()
  await expectFitsPhone(page, 'credential')

  await page.goto(`/#settings/ssh/${ALIAS}`)
  await main.getByRole('button', { name: 'Rename host' }).tap()
  await expect(main).toContainText('Agents use the new name from their next turn.')
  await expectFitsPhone(page, 'rename host')
  await main.getByLabel('New name').fill('phone-renamed')
  await main.getByLabel('New name').press('Enter')
  await expect(page).toHaveURL(/#settings\/ssh\/phone-renamed$/)
  await page.goto('/#settings/credentials/default')
  await expect(bundled.getByRole('switch', { name: 'phone-renamed in Default' })).toBeChecked()
})
