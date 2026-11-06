import { randomUUID } from 'node:crypto'
import type {
  AccessDefault,
  AuditPage,
  Connection,
  CredentialsOverview,
  StartAgentInput,
  Task,
  TaskAccessView,
} from '@seti/shared'
import { openAgentSettings } from './support/agent-settings.js'
import { openSeedDb } from './support/db.js'
import { paths } from './support/env.js'
import { apiData, expect, test, toasts } from './support/fixtures.js'

const ROLE = 'arn:aws:iam::123456789012:role/seti-agent-readonly'
const GITHUB = `github_pat_${'E2e0'.repeat(14)}`
const OWNER_TOKEN = `github_pat_${'Own1'.repeat(14)}`
const API_KEY = `vendor-${'K3y9'.repeat(8)}`

/** A task, sandboxed or not, with nothing in its transcript; a running one never has a turn start. */
async function seedTask(title: string, sandbox: boolean, status: 'idle' | 'running' = 'idle'): Promise<string> {
  const db = openSeedDb()
  const id = randomUUID()
  const ts = new Date().toISOString()
  await db.run(
    `INSERT INTO task (id, title, repo_id, cwd, worktree, sandbox, status, created_at, updated_at)
     VALUES (?, ?, NULL, ?, 0, ?, ?, ?, ?)`,
    id,
    title,
    paths.checkout,
    sandbox ? 1 : 0,
    status,
    ts,
    ts,
  )
  await db.close()
  return id
}

test.describe('credentials', () => {
  test.use({ allowedHttpStatuses: [400, 409] })

  test.afterEach(async ({ request }) => {
    const overview = await apiData<CredentialsOverview>(request, '/credentials')
    for (const profile of overview.profiles.filter((entry) => !entry.builtin)) {
      await request.delete(`/api/credentials/profiles/${profile.id}`)
    }
    for (const connection of await apiData<Connection[]>(request, '/connections')) {
      await request.delete(`/api/connections/${connection.id}`)
    }
    await request.delete('/api/credentials/profiles/default/github')
    await request.delete('/api/credentials/profiles/default/github/e2e-org')
    const reset = { role_arn: null, external_id: null, region: 'us-east-1', session_minutes: 60 }
    await request.put('/api/credentials/profiles/default/aws', { data: reset })
    await request.put('/api/access/defaults', { data: { kind: 'aws', id: 'aws', enabled: false } })
  })

  test('the list explains credentials and Default holds GitHub tokens and the AWS role', async ({ page, request }) => {
    await page.goto('/#settings/credentials')
    const main = page.getByRole('main')
    await expect(main.getByRole('heading', { name: 'Credentials', level: 2, exact: true })).toBeVisible()
    await expect(main).toContainText('A credential is the bundle an agent picks')
    const row = main.getByRole('list', { name: 'Credentials' }).getByRole('listitem', { name: 'Default' })
    await expect(row).toContainText('Built-in')
    await expect(row).toContainText('No tokens')
    await expect(row).toContainText('No role')
    await row.getByRole('button').click()
    await expect(page).toHaveURL(/#settings\/credentials\/default$/)
    await expect(main.getByRole('heading', { name: 'Default', level: 2 })).toBeVisible()
    await expect(main.getByRole('button', { name: 'Rename credential' })).toHaveCount(0)
    await expect(main.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0)

    const github = main.getByRole('region', { name: 'GitHub tokens' })
    await github.getByLabel('Default GitHub token').fill(GITHUB)
    await github.getByRole('button', { name: 'Save' }).first().click()
    await expect(toasts(page).filter({ hasText: 'GitHub token saved' })).toBeVisible()
    await github.getByLabel('GitHub owner').fill('E2E-Org')
    await github.getByLabel('GitHub token for the owner').fill(OWNER_TOKEN)
    await github.getByRole('button', { name: 'Add' }).click()
    await expect(toasts(page).filter({ hasText: 'GitHub token for e2e-org saved' })).toBeVisible()
    await expect(github.getByText('e2e-org', { exact: true })).toBeVisible()
    await expect(page.locator('body')).not.toContainText(GITHUB)
    await expect(page.locator('body')).not.toContainText(OWNER_TOKEN)

    const aws = main.getByRole('region', { name: 'AWS role' })
    await expect(aws.getByText('Not configured', { exact: true })).toBeVisible()
    await aws.getByLabel('Role ARN').fill('arn:aws:iam::1:user/me')
    await aws.getByRole('button', { name: 'Save' }).click()
    await expect(toasts(page).filter({ hasText: 'Use a role ARN' })).toBeVisible()
    await aws.getByLabel('Role ARN').fill(ROLE)
    await aws.getByLabel('External ID').fill('seti-e2e')
    await aws.getByText('IAM setup').click()
    await expect(aws.getByLabel('Trust policy')).toContainText('"sts:ExternalId": "seti-e2e"')
    await aws.getByRole('button', { name: 'Save' }).click()
    await expect(toasts(page).filter({ hasText: 'AWS role saved' })).toBeVisible()
    await expect(aws.getByText('Configured', { exact: true })).toBeVisible()

    await main.getByRole('button', { name: 'Back to credentials' }).click()
    await expect(page).toHaveURL(/#settings\/credentials$/)
    await expect(row).toContainText('Default token, e2e-org')
    await expect(row).toContainText('seti-agent-readonly')

    const overview = await apiData<CredentialsOverview>(request, '/credentials')
    const builtin = overview.profiles.find((profile) => profile.builtin)
    expect(builtin?.aws).toMatchObject({ role_arn: ROLE, external_id: 'seti-e2e' })
    expect(builtin?.github.default.configured).toBe(true)
    expect(JSON.stringify(overview)).not.toContain(GITHUB)
    const audit = await apiData<AuditPage>(request, '/audit?kind=system&limit=20')
    expect(audit.events.map((event) => event.summary)).toContain(
      `Set the AWS role of the credential Default to ${ROLE}`,
    )
    expect(JSON.stringify(audit)).not.toContain(OWNER_TOKEN)
  })

  test('a new credential is renamed in place and carries the connections switched on', async ({ page, request }) => {
    await request.post('/api/connections', {
      data: {
        name: 'e2e_vendor',
        kind: 'key',
        env: 'E2E_VENDOR',
        hosts: ['api.vendor.test'],
        values: { value: API_KEY },
      },
    })
    await page.goto('/#settings/credentials')
    const main = page.getByRole('main')
    await main.getByRole('button', { name: 'Credential', exact: true }).click()
    const create = page.getByRole('dialog', { name: 'New credential' })
    await create.getByLabel('Name', { exact: true }).fill('E2E Work')
    await create.getByRole('button', { name: 'Create' }).click()
    await expect(toasts(page).filter({ hasText: 'Created E2E Work' })).toBeVisible()
    await expect(create).toBeHidden()
    await expect(page).toHaveURL(/#settings\/credentials\/[\w-]+$/)
    await expect(main.getByRole('heading', { name: 'E2E Work', level: 2 })).toBeVisible()

    await main.getByRole('button', { name: 'Rename credential' }).click()
    const name = main.getByLabel('Name', { exact: true })
    await expect(name).toBeFocused()
    await name.fill('Never saved')
    await name.press('Escape')
    await expect(main.getByRole('heading', { name: 'E2E Work', level: 2 })).toBeVisible()
    await main.getByRole('button', { name: 'Rename credential' }).click()
    await name.fill('E2E Client Work')
    await name.press('Enter')
    await expect(toasts(page).filter({ hasText: 'Renamed to E2E Client Work' })).toBeVisible()
    await expect(main.getByRole('heading', { name: 'E2E Client Work', level: 2 })).toBeVisible()

    const connections = main.getByRole('region', { name: 'Connections' })
    const toggle = connections.getByRole('switch', { name: 'e2e_vendor in E2E Client Work' })
    await expect(toggle).not.toBeChecked()
    await toggle.click()
    await expect(toasts(page).filter({ hasText: 'E2E Client Work agents get E2E_VENDOR' })).toBeVisible()
    await expect(toggle).toBeChecked()

    const nav = page.getByRole('navigation', { name: 'Settings pages' })
    await nav.getByRole('button', { name: 'Credentials', exact: true }).click()
    await expect(page).toHaveURL(/#settings\/credentials$/)
    const row = main.getByRole('list', { name: 'Credentials' }).getByRole('listitem', { name: 'E2E Client Work' })
    await expect(row).toContainText('e2e_vendor')
    const overview = await apiData<CredentialsOverview>(request, '/credentials')
    expect(JSON.stringify(overview)).not.toContain(API_KEY)
    await expect(page.locator('body')).not.toContainText(API_KEY)
  })

  test('deleting a credential that agents use moves them to Default', async ({ page, request }) => {
    const created = await request.post('/api/credentials/profiles', { data: { name: 'E2E Doomed' } })
    const doomed = ((await created.json()) as { data: { id: string } }).data
    const title = `E2E doomed agent ${randomUUID().slice(0, 8)}`
    const id = await seedTask(title, true)
    await request.patch(`/api/tasks/${id}`, { data: { profile_id: doomed.id } })

    await page.goto('/#settings/credentials')
    const main = page.getByRole('main')
    const list = main.getByRole('list', { name: 'Credentials' })
    const row = list.getByRole('listitem', { name: 'E2E Doomed' })
    await expect(row).toContainText('1 agent')
    await row.getByRole('button').click()
    const agents = main.getByRole('region', { name: 'Agents' })
    await expect(agents.getByRole('button', { name: title })).toBeVisible()

    await main.getByRole('button', { name: 'Delete', exact: true }).click()
    const confirm = page.getByRole('dialog', { name: 'Delete E2E Doomed' })
    await expect(confirm).toContainText(`1 agent uses it: ${title}. They move to Default.`)
    await confirm.getByRole('button', { name: 'Cancel' }).click()
    await agents.getByRole('button', { name: title }).click()
    await expect(page).toHaveURL(new RegExp(`#agents/${id}$`))
    await page.goBack()

    await main.getByRole('button', { name: 'Delete', exact: true }).click()
    await page
      .getByRole('dialog', { name: 'Delete E2E Doomed' })
      .getByRole('button', { name: 'Move and delete' })
      .click()
    await expect(toasts(page).filter({ hasText: 'Deleted E2E Doomed; its agents use Default now' })).toBeVisible()
    await expect(page).toHaveURL(/#settings\/credentials$/)
    await expect(list.getByRole('listitem')).toHaveCount(1)
    expect((await apiData<Task>(request, `/tasks/${id}`)).profile_id).toBe('default')

    await page.goto(`/#settings/credentials/${doomed.id}`)
    await expect(main).toContainText('No such credential')
  })

  test('a new agent starts on Default and changes its credentials in its details', async ({ page, request }) => {
    const created = await request.post('/api/credentials/profiles', { data: { name: 'E2E Client' } })
    const client = ((await created.json()) as { data: { id: string } }).data
    const id = await seedTask(`E2E credentials ${randomUUID().slice(0, 8)}`, true)
    const unsandboxed = await seedTask(`E2E unsandboxed ${randomUUID().slice(0, 8)}`, false)

    await page.goto('/#agents/new')
    const sent: { body: StartAgentInput | null } = { body: null }
    await page.route('**/api/tasks/start', async (route) => {
      sent.body = route.request().postDataJSON() as StartAgentInput
      await route.fulfill({ json: { data: { id: 'e2e-intercepted' }, meta: {} } })
    })
    await page.getByLabel('Message').fill('Never reaches the server.')
    await page.getByLabel('Message').press('Enter')
    await expect(page).toHaveURL(/#agents\/e2e-intercepted$/)
    const { workspace_id } = await apiData<Task>(request, `/tasks/${id}`)
    expect(sent.body).toEqual({ prompt: 'Never reaches the server.', workspace_id, client_id: expect.any(String) })
    await page.unroute('**/api/tasks/start')

    await page.goto(`/#agents/${id}`)
    const details = await openAgentSettings(page, 'Access')
    const select = details.getByRole('combobox', { name: 'Credentials' })
    await expect(select).toHaveValue('default')
    const inherited = details.getByText('Inherited', { exact: true })
    await inherited.hover()
    await expect(page.getByRole('tooltip')).toContainText('the Default set')
    await select.selectOption({ label: 'E2E Client' })
    await expect(toasts(page).filter({ hasText: 'Applies from the next turn' })).toBeVisible()
    await expect.poll(async () => (await apiData<Task>(request, `/tasks/${id}`)).profile_id).toBe(client.id)
    await expect(details).toContainText('Custom')
    await expect(inherited).toHaveCount(0)
    await details.getByRole('button', { name: 'Reset credentials to Default' }).click()
    await expect.poll(async () => (await apiData<Task>(request, `/tasks/${id}`)).profile_id).toBe('default')
    await expect(select).toHaveValue('default')

    await details.getByRole('button', { name: 'Edit access' }).click()
    const access = page.getByRole('dialog', { name: /^Access of / })
    const region = access.getByRole('region', { name: 'Credentials' })
    await expect(region.getByRole('combobox', { name: 'Credentials' })).toHaveValue('default')
    await region.getByRole('combobox', { name: 'Credentials' }).selectOption({ label: 'E2E Client' })
    await expect.poll(async () => (await apiData<Task>(request, `/tasks/${id}`)).profile_id).toBe(client.id)
    await expect(region).toContainText('Custom')

    await page.goto(`/#settings/credentials/${client.id}`)
    const agents = page.getByRole('main').getByRole('region', { name: 'Agents' })
    await expect(agents.getByRole('list', { name: 'Agents using this set' }).getByRole('listitem')).toHaveCount(1)

    await page.goto(`/#agents/${unsandboxed}`)
    const hostDetails = await openAgentSettings(page, 'Access')
    await expect(hostDetails.getByRole('list', { name: 'What this agent gets' })).toHaveCount(0)
    await page.getByRole('button', { name: 'Edit access' }).click()
    await expect(page.getByRole('dialog', { name: /^Access of / })).toContainText(
      'SSH, AWS and credentials need the sandbox.',
    )
  })

  test('a running agent switches credentials from its details without waiting for the turn', async ({
    page,
    request,
  }) => {
    const created = await request.post('/api/credentials/profiles', { data: { name: 'E2E Running' } })
    const running = ((await created.json()) as { data: { id: string } }).data
    const id = await seedTask(`E2E running ${randomUUID().slice(0, 8)}`, true, 'running')

    await page.goto(`/#agents/${id}`)
    await expect(page.getByRole('combobox', { name: 'Reply' })).toHaveAttribute('placeholder', /^Enter queues it/)
    const details = await openAgentSettings(page, 'Access')
    const select = details.getByRole('combobox', { name: 'Credentials' })
    await expect(select).toBeEnabled()
    await select.selectOption({ label: 'E2E Running' })
    await expect(toasts(page).filter({ hasText: 'Applies from the next turn' })).toBeVisible()
    await expect(details).toBeVisible()
    await expect(details).toContainText('Custom')
    await expect
      .poll(async () => {
        const task = await apiData<Task>(request, `/tasks/${id}`)
        return [task.status, task.profile_id]
      })
      .toEqual(['running', running.id])

    await select.selectOption({ label: 'Default' })
    await expect.poll(async () => (await apiData<Task>(request, `/tasks/${id}`)).profile_id).toBe('default')
    await expect(details).toBeVisible()
    await expect(select).toHaveValue('default')
    const view = await apiData<TaskAccessView>(request, `/tasks/${id}/access`)
    expect(view.aws).toEqual({ state: 'no_role', profile: 'Default' })
    await page.keyboard.press('Escape')
    await expect(details).toBeHidden()
    expect((await request.delete(`/api/tasks/${id}`)).ok()).toBe(true)
  })

  test('picking a set with an AWS role turns AWS on, and the agent access keeps only the switch', async ({
    page,
    request,
  }) => {
    const created = await request.post('/api/credentials/profiles', { data: { name: 'E2E Devops' } })
    const devops = ((await created.json()) as { data: { id: string } }).data
    const role = { role_arn: ROLE, external_id: null, region: 'us-east-1', session_minutes: 60 }
    expect((await request.put(`/api/credentials/profiles/${devops.id}/aws`, { data: role })).ok()).toBe(true)
    await request.post('/api/credentials/profiles', { data: { name: 'E2E No role' } })
    const id = await seedTask(`E2E aws role ${randomUUID().slice(0, 8)}`, true)
    const awsOf = async () => (await apiData<TaskAccessView>(request, `/tasks/${id}/access`)).aws

    await page.goto(`/#agents/${id}`)
    const details = await openAgentSettings(page, 'Access')
    await expect(details.getByRole('list', { name: 'What this agent gets' })).toHaveCount(0)
    await expect(details).not.toContainText('Gets')
    expect(await awsOf()).toEqual({ state: 'no_role', profile: 'Default' })

    await details.getByRole('combobox', { name: 'Credentials' }).selectOption({ label: 'E2E Devops' })
    await expect(toasts(page).filter({ hasText: 'AWS on: seti-agent-readonly' })).toBeVisible()
    const chip = page.getByRole('list', { name: 'Access' }).getByRole('listitem').filter({ hasText: 'AWS' })
    await expect(chip.locator('[data-state]')).toHaveAttribute('data-state', 'on')
    expect(await awsOf()).toMatchObject({ state: 'on', region: 'us-east-1' })

    await details.getByRole('button', { name: 'Edit access' }).click()
    const access = page.getByRole('dialog', { name: /^Access of / })
    const aws = access.getByRole('region', { name: 'AWS' }).getByRole('switch', { name: 'AWS', exact: true })
    await expect(aws).toBeChecked()
    await aws.click()
    await expect(aws).not.toBeChecked()
    await expect.poll(async () => (await awsOf()).state).toBe('off')

    await access.getByRole('combobox', { name: 'Credentials' }).selectOption({ label: 'E2E No role' })
    await expect.poll(async () => (await awsOf()).state).toBe('no_role')
    await page.keyboard.press('Escape')
    expect((await request.delete(`/api/tasks/${id}`)).ok()).toBe(true)
  })

  test('the agent access links to its credential on the Credentials page', async ({ page, request }) => {
    const created = await request.post('/api/credentials/profiles', { data: { name: 'E2E Linked' } })
    const linked = ((await created.json()) as { data: { id: string } }).data
    const id = await seedTask(`E2E linked ${randomUUID().slice(0, 8)}`, true)
    await request.patch(`/api/tasks/${id}`, { data: { profile_id: linked.id } })

    await page.goto(`/#agents/${id}`)
    const details = await openAgentSettings(page, 'Access')
    await details.getByRole('link', { name: 'Manage in Settings, Credentials' }).click()
    await expect(page).toHaveURL(new RegExp(`#settings/credentials/${linked.id}$`))
    await expect(page.getByRole('main').getByRole('heading', { name: 'E2E Linked', level: 2 })).toBeVisible()
    expect((await request.delete(`/api/tasks/${id}`)).ok()).toBe(true)
  })

  test('AWS is off by default, turned on for one agent in its details and by default in settings', async ({
    page,
    request,
  }) => {
    const id = await seedTask(`E2E aws ${randomUUID().slice(0, 8)}`, true)
    const awsOf = async () =>
      (await apiData<TaskAccessView>(request, `/tasks/${id}/access`)).items.find((item) => item.kind === 'aws')
    await page.goto(`/#agents/${id}`)
    await openAgentSettings(page, 'Access')
    const sandbox = page.getByRole('dialog').getByRole('button', { name: 'Sandbox' })
    await sandbox.click()
    await expect(sandbox).toHaveAttribute('aria-pressed', 'false')
    await sandbox.click()
    await expect(sandbox).toHaveAttribute('aria-pressed', 'true')

    await page.getByRole('button', { name: 'Edit access' }).click()
    const access = page.getByRole('dialog', { name: /^Access of / })
    const region = access.getByRole('region', { name: 'AWS' })
    const aws = region.getByRole('switch', { name: 'AWS', exact: true })
    await expect(aws).not.toBeChecked()
    await expect(region).toContainText('Inherited')
    await aws.click()
    await expect(aws).toBeChecked()
    await expect(region).toContainText('Custom')
    expect(await awsOf()).toMatchObject({ enabled: true, override: true, default_enabled: false })
    await region.getByRole('button', { name: 'Reset AWS to default' }).click()
    await expect(aws).not.toBeChecked()
    expect(await awsOf()).toMatchObject({ enabled: false, override: null })
    await page.keyboard.press('Escape')

    await page.goto('/#settings/credentials')
    const byDefault = page.getByRole('main').getByRole('switch', { name: 'AWS on by default' })
    await expect(byDefault).not.toBeChecked()
    await byDefault.click()
    await expect(toasts(page).filter({ hasText: 'AWS is on by default' })).toBeVisible()
    const catalog = await apiData<AccessDefault[]>(request, '/access')
    expect(catalog.find((item) => item.kind === 'aws')?.default_enabled).toBe(true)
    expect(await awsOf()).toMatchObject({ enabled: true, override: null })
  })
})
