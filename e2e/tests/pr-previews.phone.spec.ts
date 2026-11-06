import { fakeGhEnv } from './support/fake-gh-env.js'
import { expect, test, unique } from './support/fixtures.js'
import { setModEnabled } from './support/mods.js'
import { openAgentPrs } from './support/phone-agent.js'
import { previewHostStatus, seedPreviewAgent, setPreviews } from './support/pr-previews.js'

test.use({ serverEnv: fakeGhEnv() })

test.afterEach(async ({ request }) => {
  await setModEnabled(request, 'pr-previews', true)
})

test('on a phone the linked PR sheet shows the preview link while the PR previews mod is on', async ({
  page,
  request,
  setiServer,
}) => {
  const { baseURL } = setiServer
  const { id, host, label } = await seedPreviewAgent(unique('site'))
  await page.goto(`/#agents/${id}`)
  const link = page
    .getByRole('dialog', { name: /^Linked PRs/ })
    .getByRole('listitem', { name: `Pull request ${label}` })
    .getByRole('link', { name: 'preview', exact: true })
  await openAgentPrs(page)
  await expect(link).toBeVisible()

  await setPreviews(page, request, false)
  await openAgentPrs(page)
  await expect(page.getByRole('listitem', { name: `Pull request ${label}` })).toBeVisible()
  await expect(link).toHaveCount(0)
  expect(await previewHostStatus(request, baseURL, host)).toBe(404)

  await setPreviews(page, request, true)
  await openAgentPrs(page)
  await expect(link).toBeVisible()
  expect(await previewHostStatus(request, baseURL, host)).toBe(502)
})
