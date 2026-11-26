import { fakeGhEnv } from './support/fake-gh-env.js'
import { PERMISSION_PROMPT } from './support/fake-permission.js'
import { expect, test, unique } from './support/fixtures.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'
import {
  addAskRule,
  LEASE_TITLE,
  LEASE_URL,
  MERGE,
  requestCard,
  seedLeasePr,
  startAsking,
} from './support/request-prs.js'

test.use({ serverEnv: { ...FAKE_CLAUDE_ENV, ...fakeGhEnv() } })

test.beforeEach(() => {
  seedLeasePr()
})

test('a request whose command merges a PR shows the PR with its title, CI and a GitHub link', async ({
  page,
  request,
}) => {
  const id = await startAsking(request, MERGE)
  await page.goto(`/#agents/${id}`)
  const chip = requestCard(page).getByRole('group', { name: 'Pull request tool#2136' })
  await expect(chip).toContainText(LEASE_TITLE)
  await expect(chip).toContainText('ci pass')
  const link = chip.getByRole('link', { name: 'Open tool#2136 on GitHub' })
  await expect(link).toHaveAttribute('href', LEASE_URL)
  await expect(link).toHaveAttribute('target', '_blank')
  await expect(requestCard(page).getByRole('button', { name: 'Always' })).toBeVisible()
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await requestCard(page).screenshot({ path: test.info().outputPath(`request-pr-desktop-${scheme}.png`) })
  }
})

test('a command naming five PRs shows three of them, then +2', async ({ page, request }) => {
  const command = [1, 2, 3, 4, 5].map((n) => `gh pr view ${String(n)} -R acme/tool`).join('; ')
  const id = await startAsking(request, command)
  await page.goto(`/#agents/${id}`)
  const prs = requestCard(page).getByRole('group', { name: 'Pull requests' })
  await expect(prs.getByRole('group', { name: /^Pull request tool#/ })).toHaveCount(3)
  await expect(prs.getByRole('link', { name: 'Open tool#1 on GitHub' })).toHaveAttribute(
    'href',
    'https://github.com/acme/tool/pull/1',
  )
  await expect(prs.getByText('+2', { exact: true })).toBeVisible()
  await requestCard(page).screenshot({ path: test.info().outputPath('request-prs-more-desktop.png') })
})

test('a command an ask rule holds offers no Always; one without a PR shows no PR line', async ({ page, request }) => {
  const remove = await addAskRule(request, 'Bash(gh pr merge:*)')
  try {
    const held = await startAsking(request, MERGE)
    await page.goto(`/#agents/${held}`)
    await expect(requestCard(page).getByRole('group', { name: 'Pull request tool#2136' })).toBeVisible()
    await expect(requestCard(page).getByRole('button', { name: 'Allow', exact: true })).toBeVisible()
    await expect(requestCard(page).getByRole('button', { name: 'Always' })).toHaveCount(0)
    await expect(requestCard(page).getByText('Always adds')).toHaveCount(0)
  } finally {
    await remove()
  }

  const response = await request.post('/api/tasks', {
    data: { title: unique('Deployer'), prompt: `Please ${PERMISSION_PROMPT}`, sandbox: false },
  })
  const { data } = (await response.json()) as { data: { id: string } }
  await page.goto(`/#agents/${data.id}`)
  await expect(requestCard(page).getByRole('button', { name: 'Always' })).toBeVisible()
  await expect(requestCard(page).getByRole('group', { name: 'Pull requests' })).toHaveCount(0)
})
