import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SshStatus } from '@seti/shared'
import { openSeedDb } from './support/db.js'
import { paths } from './support/env.js'
import { apiData, expect, test, toasts } from './support/fixtures.js'
import { addHost, addKey, clearSsh, SSHD, startSshd } from './support/ssh.js'

test.describe('ssh host check', () => {
  test.use({ allowedHttpStatuses: [409] })

  test.afterEach(async ({ request }) => {
    await clearSsh(request)
  })

  test('a host without a key shows No key and is never checked until one is chosen', async ({ page, request }) => {
    const key = await addKey(request, 'e2e later')
    const db = openSeedDb()
    const ts = new Date().toISOString()
    await db.run(
      `INSERT INTO ssh_host (alias, hostname, port, username, key_id, jump, options, created_at, updated_at)
       VALUES ('bare', '203.0.113.40', 22, 'ops', NULL, NULL, '[]', ?, ?)`,
      ts,
      ts,
    )
    await db.close()
    const checks: string[] = []
    page.on('request', (sent) => {
      if (/\/api\/ssh\/hosts\/[^/]+\/check$/.test(sent.url())) {
        checks.push(sent.url())
      }
    })

    await page.goto('/#settings/ssh')
    const main = page.getByRole('main')
    const row = main.getByRole('list', { name: 'SSH hosts' }).getByRole('listitem', { name: 'bare' })
    await expect(row).not.toContainText('No trusted host key')
    await row.getByRole('button', { name: 'No key for bare' }).click()
    await expect(main.getByRole('heading', { name: 'bare', level: 2 })).toBeVisible()
    const facts = main.getByRole('region', { name: 'Connection', exact: true })
    const select = facts.getByLabel('SSH key', { exact: true })
    await expect(select.locator('option:checked')).toHaveText('No key: choose one')
    await expect(main.getByRole('button', { name: 'Check host' })).toBeDisabled()
    await facts.getByLabel('Host name').fill('203.0.113.41')
    await expect(facts.getByRole('button', { name: 'Save' })).toBeDisabled()
    const refused = await request.post('/api/ssh/hosts/bare/check', { data: {} })
    expect(refused.status()).toBe(409)
    expect(await refused.text()).toContain('Choose a key for bare before checking bare')
    expect(checks).toEqual([])

    await select.selectOption({ label: 'e2e later' })
    const checked = page.waitForRequest((sent) => sent.url().endsWith('/api/ssh/hosts/bare/check'))
    await facts.getByRole('button', { name: 'Save' }).click()
    await expect(toasts(page).filter({ hasText: 'bare saved' })).toBeVisible()
    await checked
    expect((await apiData<SshStatus>(request, '/ssh')).hosts).toMatchObject([
      { alias: 'bare', hostname: '203.0.113.41', key_id: key.id },
    ])
  })

  test('checks a host once it has a key: its host key to trust and a login with that key', async ({
    page,
    request,
  }) => {
    test.skip(!fs.existsSync(SSHD), 'needs sshd')
    const key = await addKey(request, 'e2e check')
    const other = await addKey(request, 'e2e other')
    const sshd = await startSshd(path.join(paths.root, `sshd-${randomUUID().slice(0, 8)}`), key.public_key)
    const user = os.userInfo().username
    try {
      await addHost(request, 'box', '127.0.0.1', { port: sshd.port, key_id: key.id, user })
      await page.goto('/#settings/ssh/box')
      const main = page.getByRole('main')
      const keys = main.getByRole('region', { name: 'Host keys' })
      await expect(keys).toContainText('Not trusted yet')
      await keys.getByRole('button', { name: 'Check host' }).click()
      await expect(keys.getByRole('status', { name: 'SSH login' })).toHaveText(`Logged in as ${user} with e2e check`)
      await expect(keys.getByRole('list', { name: 'Host keys of box' })).toContainText('ssh-ed25519 SHA256:')
      await keys.getByRole('button', { name: 'Trust' }).click()
      await expect(toasts(page).filter({ hasText: 'box trusted' })).toBeVisible()
      await expect(keys.getByRole('list', { name: 'Trusted host keys' })).toContainText('ssh-ed25519 SHA256:')

      const facts = main.getByRole('region', { name: 'Connection', exact: true })
      await facts.getByLabel('SSH key', { exact: true }).selectOption({ label: other.name })
      await facts.getByRole('button', { name: 'Save' }).click()
      await expect(keys.getByRole('status', { name: 'SSH login' })).toContainText('Login failed:')
      await expect(keys.getByRole('status', { name: 'SSH login' })).toContainText('Permission denied')
      await expect(keys.getByRole('list', { name: 'Host keys of box' })).toContainText('(trusted)')

      await keys.getByRole('button', { name: `Forget [127.0.0.1]:${String(sshd.port)}` }).click()
      await expect(keys).toContainText('Not trusted yet')
    } finally {
      sshd.stop()
    }
  })
})
