import { fakeGhEnv } from './support/fake-gh-env.js'
import { expect, test } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'
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

test('on a phone the PR line stays on one line with its title cut, and fits the screen', async ({ page, request }) => {
  const id = await startAsking(request, MERGE)
  await page.goto(`/#agents/${id}`)
  const chip = requestCard(page).getByRole('group', { name: 'Pull request tool#2136' })
  await expect(chip).toContainText(LEASE_TITLE)
  await expect(chip).toContainText('ci pass')
  await expect(chip.getByRole('link', { name: 'Open tool#2136 on GitHub' })).toHaveAttribute('href', LEASE_URL)
  const box = await chip.boundingBox()
  expect(box?.height ?? 0, 'one line, the 44px link included').toBeLessThanOrEqual(46)
  await expectFitsPhone(page, 'request PR line')
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await requestCard(page).screenshot({ path: test.info().outputPath(`request-pr-phone-${scheme}.png`) })
  }
})

test('on a phone five PRs show as three and +2, and an ask rule leaves no Always', async ({ page, request }) => {
  const command = [1, 2, 3, 4, 5].map((n) => `gh pr view ${String(n)} -R acme/tool`).join('; ')
  const many = await startAsking(request, command)
  await page.goto(`/#agents/${many}`)
  const prs = requestCard(page).getByRole('group', { name: 'Pull requests' })
  await expect(prs.getByRole('group', { name: /^Pull request tool#/ })).toHaveCount(3)
  await expect(prs.getByText('+2', { exact: true })).toBeVisible()
  await expectFitsPhone(page, 'request PR lines')

  const remove = await addAskRule(request, 'Bash(gh pr merge:*)')
  try {
    const held = await startAsking(request, MERGE)
    await page.goto(`/#agents/${held}`)
    await expect(requestCard(page).getByRole('group', { name: 'Pull request tool#2136' })).toBeVisible()
    await expect(requestCard(page).getByRole('button', { name: 'Always' })).toHaveCount(0)
    await page.screenshot({ path: test.info().outputPath('request-pr-ask-rule-phone.png') })
  } finally {
    await remove()
  }
})
