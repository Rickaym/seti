import type { ContextPack, ContextPackSummary, Task } from '@seti/shared'
import { apiData, expect, test } from './support/fixtures.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'
import { newRole, openRole, removePacks, roleNow } from './support/roles.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

const made: ContextPack[] = []

test.afterEach(async ({ request }) => {
  await removePacks(request, made.splice(0))
})

test('a role takes a model, which agents started in it run on, and goes back to any', async ({ page, request }) => {
  const role = await newRole(request, 'Reviewer', 'you review PRs.')
  made.push(role)
  const picker = await openRole(page, role.name)
  await expect(picker).toHaveValue('')
  await picker.selectOption({ label: 'Opus' })
  await expect.poll(async () => (await roleNow(request, role.id)).model).toBe('opus')
  expect((await roleNow(request, role.id)).runtime).toBe('claude')
  await page.reload()
  await expect(page.getByRole('main').getByRole('combobox', { name: 'Runs on' })).toHaveValue('claude:opus')
  await page.getByRole('main').getByRole('combobox', { name: 'Runs on' }).selectOption({ label: 'Any model' })
  await expect.poll(async () => (await roleNow(request, role.id)).runtime).toBeNull()
})

test('a start names a role by name, and a name no role has is refused with the roles there are', async ({
  request,
}) => {
  const role = await newRole(request, 'Release lead', 'you run the release.')
  made.push(role)
  const refused = await request.post('/api/tasks/start', { data: { prompt: 'Ship it', role: 'Nobody here' } })
  expect(refused.status()).toBe(404)
  const message = JSON.stringify(await refused.json())
  expect(message).toContain('No role is named Nobody here; the roles are')
  expect(message).toContain(role.name)

  const started = await request.post('/api/tasks/start', { data: { prompt: 'Ship it', role: role.name } })
  expect(started.ok(), 'POST /api/tasks/start').toBe(true)
  const task = ((await started.json()) as { data: Task }).data
  const linked = await apiData<ContextPackSummary[]>(request, `/tasks/${task.id}/context-packs`)
  expect(linked.filter((pack) => pack.kind === 'role').map((pack) => pack.id)).toEqual([role.id])
  expect((await request.delete(`/api/tasks/${task.id}`)).ok()).toBe(true)
})
