import { fakeGhEnv } from './support/fake-gh-env.js'
import { PERMISSION_PROMPT } from './support/fake-permission.js'
import { expect, test, unique } from './support/fixtures.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'
import {
  addAskRule,
  AGENT_PRS,
  DASH_TITLE,
  DASH_URL,
  LIVE_DESCRIPTION,
  LIVE_MERGE,
  archiveStarted,
  described,
  MERGE_DESCRIPTION,
  RETRY_TITLE,
  LEASE_TITLE,
  LEASE_URL,
  MERGE,
  requestCard,
  seedLeasePr,
  startAsking,
  track,
} from './support/request-prs.js'

test.use({ serverEnv: { ...FAKE_CLAUDE_ENV, ...fakeGhEnv() } })

test.beforeEach(() => {
  seedLeasePr()
})

test.afterEach(async ({ request }) => {
  await archiveStarted(request)
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
  track(data.id)
  await page.goto(`/#agents/${data.id}`)
  await expect(requestCard(page).getByRole('button', { name: 'Always' })).toBeVisible()
  await expect(requestCard(page).getByRole('group', { name: 'Pull requests' })).toHaveCount(0)
})

test("the agent's description reads first, then the command and a merged PR, and never as the reason", async ({
  page,
  request,
}) => {
  const command = 'gh pr view 2140 -R acme/tool --json state'
  const id = await startAsking(request, described(command, MERGE_DESCRIPTION))
  await page.goto('/#agents')
  const row = page.getByRole('main').getByRole('region', { name: 'Needs you' }).locator(`[data-task-id="${id}"]`)
  await expect(row).toContainText(`Asks to use Bash: ${MERGE_DESCRIPTION}`)
  await page.goto(`/#agents/${id}`)
  const card = requestCard(page)
  const said = card.getByText(MERGE_DESCRIPTION, { exact: true })
  const ran = card.locator('code').getByText(command, { exact: true })
  const chip = card.getByRole('group', { name: 'Pull request tool#2140' })
  const top = async (part: typeof said) => (await part.boundingBox())?.y ?? 0
  await expect(said).toBeVisible()
  await expect(
    card.getByText(MERGE_DESCRIPTION, { exact: true }),
    'the description shows once, never as the reason',
  ).toHaveCount(1)
  expect(await top(said)).toBeLessThan(await top(ran))
  expect(await top(ran)).toBeLessThan(await top(chip))
  await expect(chip).toContainText(RETRY_TITLE)
  await expect(chip.getByRole('img', { name: 'Merged' })).toBeVisible()
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await card.screenshot({ path: test.info().outputPath(`order-desktop-${scheme}.png`) })
  }
})

test("a merge an Ask rule holds names the rule, and finds the PR in the agent's repositories", async ({
  page,
  request,
}) => {
  const remove = await addAskRule(request, 'Bash(gh pr merge:*)')
  try {
    const id = await startAsking(request, described(LIVE_MERGE, LIVE_DESCRIPTION), AGENT_PRS)
    await page.goto(`/#agents/${id}`)
    const card = requestCard(page)
    await expect(card.getByText(LIVE_DESCRIPTION, { exact: true })).toHaveCount(1)
    await expect(card.getByText('Your Ask rule holds this: Bash(gh pr merge:*)', { exact: true })).toBeVisible()
    const chip = card.getByRole('group', { name: 'Pull request dash#3782' })
    await expect(chip).toContainText(DASH_TITLE)
    await expect(chip.getByRole('link', { name: 'Open dash#3782 on GitHub' })).toHaveAttribute('href', DASH_URL)
    await expect(card.getByRole('group', { name: /^Pull request tool#/ })).toHaveCount(0)
    await expect(card.getByRole('button', { name: 'Always' })).toHaveCount(0)
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme })
      await card.screenshot({ path: test.info().outputPath(`live-desktop-${scheme}.png`) })
    }
  } finally {
    await remove()
  }
})
