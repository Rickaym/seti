import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import type { AuditPage, Envelope, Repo, Task, WarmCacheStatus } from '@seti/shared'
import { openAgentSettings } from './support/agent-settings.js'
import { paths } from './support/env.js'
import { apiData, expect, removeRepos, test, toasts, unique } from './support/fixtures.js'

test.use({ allowedHttpStatuses: [400] })

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Seti E2E',
  GIT_AUTHOR_EMAIL: 'e2e@seti.invalid',
  GIT_COMMITTER_NAME: 'Seti E2E',
  GIT_COMMITTER_EMAIL: 'e2e@seti.invalid',
}

function git(cwd: string, ...args: string[]): void {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- uses the git on the runner PATH
  execFileSync('git', args, { cwd, env: GIT_ENV, stdio: 'pipe' })
}

/** A TypeScript checkout without incremental builds, with an origin and ignored tsbuildinfo files. */
function tsCheckout(name: string): string {
  const checkout = path.join(paths.root, name)
  const origin = path.join(paths.root, `${name}.git`)
  fs.mkdirSync(checkout, { recursive: true })
  git(paths.root, 'init', '--bare', '--initial-branch=main', origin)
  git(checkout, 'init', '--initial-branch=main')
  fs.writeFileSync(path.join(checkout, '.gitignore'), '*.tsbuildinfo\n')
  fs.writeFileSync(path.join(checkout, 'tsconfig.json'), '{ "compilerOptions": { "strict": true } }\n')
  git(checkout, 'add', '.')
  git(checkout, 'commit', '--message', 'chore: seed typescript repo')
  git(checkout, 'remote', 'add', 'origin', origin)
  git(checkout, 'push', '--set-upstream', 'origin', 'main')
  return checkout
}

const main = (page: Page) => page.getByRole('main')

test('a repo turns warm caches off and on, edits its patterns and cap, and new agents start warm', async ({
  page,
  request,
}) => {
  const name = unique('warmrepo')
  const checkout = tsCheckout(name)
  const added = await request.post('/api/repos', { data: { slug: `e2e/${name}`, path: checkout, base_branch: 'main' } })
  expect(added.ok()).toBe(true)
  const repo = ((await added.json()) as Envelope<Repo>).data
  const status = async () => apiData<WarmCacheStatus>(request, `/repos/${repo.id}/warm-caches`)

  await page.goto('/#settings/repos')
  const row = page.getByRole('row', { name: new RegExp(`${repo.slug} `) })
  await row.getByRole('button', { name: 'Edit' }).click()
  const dialog = page.getByRole('dialog', { name: 'Edit repo' })
  const warm = dialog.getByRole('region', { name: 'Warm caches' })
  await expect(warm.getByRole('note')).toContainText('cannot be warmed')
  await expect(warm.getByLabel('Cache patterns')).toHaveValue(/\*\*\/\*\.tsbuildinfo\n\*\*\/\.next\/cache/)
  await warm.getByRole('switch', { name: 'Warm caches' }).click()
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog).toBeHidden()
  await expect.poll(async () => (await status()).settings.enabled).toBe(false)

  await row.getByRole('button', { name: 'Edit' }).click()
  await expect(warm.getByRole('switch', { name: 'Warm caches' })).not.toBeChecked()
  await warm.getByRole('switch', { name: 'Warm caches' }).click()
  await warm.getByLabel('Cache patterns').fill('**/*.tsbuildinfo\n.env.local')
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(toasts(page).filter({ hasText: '.env files are never copied' })).toBeVisible()
  await expect(dialog).toBeVisible()
  await warm.getByLabel('Cache patterns').fill('**/*.tsbuildinfo\n**/.vite')
  await warm.getByLabel('Size cap').fill('512')
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog).toBeHidden()
  await expect
    .poll(async () => (await status()).settings)
    .toMatchObject({ enabled: true, patterns: ['**/*.tsbuildinfo', '**/.vite'], max_mb: 512 })
  const audit = await apiData<AuditPage>(request, '/audit?kind=repo.warm_caches_changed&limit=20')
  expect(audit.events.find((event) => event.subject_id === repo.id)?.summary).toBe(
    `Warm caches for ${repo.slug}: turned on; added **/.vite; removed **/.next/cache, **/.turbo, ` +
      '**/node_modules/.cache, **/.mypy_cache, **/.ruff_cache, **/.pytest_cache; cap 512 MB',
  )

  fs.writeFileSync(path.join(checkout, 'tsconfig.tsbuildinfo'), '{"warm":true}')
  await page.goto('/#agents/new')
  await page.getByLabel('Message').fill(`Typecheck ${name}`)
  await page.getByLabel('Message').press('Enter')
  await expect(page).toHaveURL(/#agents\/[\da-f-]{36}$/)
  const id = new URL(page.url()).hash.split('/')[1] ?? ''
  const details = await openAgentSettings(page, 'Session')
  await expect(details.getByRole('list', { name: 'Warm caches' })).toHaveText('1 path, 1 KB from main checkout')
  await page.keyboard.press('Escape')
  await expect(details).toBeHidden()
  await expect(main(page).getByLabel('Warm caches', { exact: true })).toHaveCount(0)
  const task = await apiData<Task>(request, `/tasks/${id}`)
  expect(fs.readFileSync(path.join(task.cwd, 'tsconfig.tsbuildinfo'), 'utf8')).toBe('{"warm":true}')

  await page.goto('/#agents')
  expect((await request.delete(`/api/tasks/${id}`)).ok()).toBe(true)
  await removeRepos(request, [repo])
})
