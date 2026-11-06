import type { SshKey, SshStatus } from '@seti/shared'
import { apiData, expect, test } from './support/fixtures.js'

const PAGES = [
  { label: 'Connections', hash: 'connections', regions: ['Connections'] },
  { label: 'Credentials', hash: 'credentials', regions: ['Credentials', 'Agent tokens'] },
  { label: 'SSH', hash: 'ssh', regions: ['SSH keys'] },
] as const

test.afterEach(async ({ request }) => {
  const status = await apiData<SshStatus>(request, '/ssh')
  for (const host of status.hosts) {
    await request.delete(`/api/ssh/hosts/${host.alias}`)
  }
  for (const key of status.keys) {
    await request.delete(`/api/ssh/keys/${key.id}`)
  }
})

test('connections, credentials and ssh each have their own page', async ({ page }) => {
  await page.goto('/#settings')
  const nav = page.getByRole('navigation', { name: 'Settings pages' })
  const security = nav.getByRole('group', { name: 'Security' })
  await expect(nav.getByRole('button', { name: 'Secrets & API keys', exact: true })).toHaveCount(0)
  await expect(nav.getByRole('button', { name: 'Named secrets', exact: true })).toHaveCount(0)
  const main = page.getByRole('main')
  for (const entry of PAGES) {
    await security.getByRole('button', { name: entry.label, exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`#settings/${entry.hash}$`))
    await expect(main.getByRole('heading', { name: entry.label, level: 2, exact: true })).toBeVisible()
    for (const region of entry.regions) {
      await expect(main.getByRole('region', { name: region })).toBeVisible()
    }
    await expect(main.getByRole('tablist')).toHaveCount(0)
  }
  const cards = main.getByRole('region', { name: /^SSH (keys|hosts)$/ })
  await expect(cards).toHaveCount(2)
  await expect(cards.first()).toHaveAccessibleName('SSH keys')
  await page.goBack()
  await expect(page).toHaveURL(/#settings\/credentials$/)
})

test('old Credentials tab links and bare set links open their own pages', async ({ page, request }) => {
  const key = ((await (await request.post('/api/ssh/keys', { data: { name: 'redirect' } })).json()) as { data: SshKey })
    .data
  await request.post('/api/ssh/hosts', {
    data: { alias: 'moved', hostname: '203.0.113.30', user: 'ops', key_id: key.id },
  })
  const main = page.getByRole('main')

  await page.goto('/#settings/credentials/hosts')
  await expect(page).toHaveURL(/#settings\/ssh$/)
  await expect(main.getByRole('list', { name: 'SSH hosts' })).toContainText('moved')

  await page.goto('/#settings/credentials/hosts/moved')
  await expect(page).toHaveURL(/#settings\/ssh\/moved$/)
  await expect(main.getByRole('heading', { name: 'moved', level: 2 })).toBeVisible()

  await page.goto(`/#settings/credentials/keys/${key.id}`)
  await expect(page).toHaveURL(new RegExp(`#settings/ssh/keys/${key.id}$`))
  await expect(main.getByRole('heading', { name: 'redirect', level: 2 })).toBeVisible()
  await expect(main.getByRole('list', { name: 'Hosts using redirect' })).toContainText('moved')
  await main.getByRole('button', { name: 'Back to SSH' }).click()
  await expect(page).toHaveURL(/#settings\/ssh$/)
  await expect(main.getByRole('list', { name: 'SSH keys' })).toContainText('redirect')

  await page.goto(`/#settings/ssh-keys/${key.id}`)
  await expect(page).toHaveURL(new RegExp(`#settings/ssh/keys/${key.id}$`))
  await expect(main.getByRole('heading', { name: 'redirect', level: 2 })).toBeVisible()
  await page.goto('/#settings/ssh-hosts/moved')
  await expect(page).toHaveURL(/#settings\/ssh\/moved$/)
  await expect(main.getByRole('heading', { name: 'moved', level: 2 })).toBeVisible()

  await page.goto('/#settings/credentials/secrets')
  await expect(page).toHaveURL(/#settings\/credentials$/)
  await expect(main.getByRole('region', { name: 'Agent tokens' })).toBeVisible()

  await page.goto('/#settings/secrets')
  await expect(page).toHaveURL(/#settings\/credentials$/)
  await expect(main.getByRole('region', { name: 'Agent tokens' })).toBeInViewport()

  await page.goto('/#settings/credentials/default')
  await expect(main.getByRole('heading', { name: 'Default', level: 2 })).toBeVisible()
  await expect(main.getByRole('region', { name: 'SSH hosts' })).toContainText('moved')
})
