import { fakeGhEnv } from './support/fake-gh-env.js'
import { expect, test, unique } from './support/fixtures.js'
import { setModEnabled } from './support/mods.js'
import { previewHostStatus, previewLink, seedPreviewAgent, setPreviews } from './support/pr-previews.js'

test.use({ serverEnv: fakeGhEnv() })

test.afterEach(async ({ request }) => {
  await setModEnabled(request, 'pr-previews', true)
})

test('the PR previews mod links a PR to its preview host and proxies it; off, both are gone', async ({
  page,
  request,
  setiServer,
}) => {
  const { baseURL } = setiServer
  const { id, host, label } = await seedPreviewAgent(unique('docs'))
  await page.goto(`/#agents/${id}`)
  const link = previewLink(page, label)
  await expect(link).toHaveAttribute('href', `http://${host}:${new URL(baseURL).port}/`)
  expect(await previewHostStatus(request, baseURL, host)).toBe(502)

  await setPreviews(page, request, false)
  await expect(page.getByRole('main').getByRole('group', { name: `Pull request ${label}` })).toBeVisible()
  await expect(link).toHaveCount(0)
  expect(await previewHostStatus(request, baseURL, host)).toBe(404)

  await setPreviews(page, request, true)
  await expect(link).toHaveAttribute('href', `http://${host}:${new URL(baseURL).port}/`)
  expect(await previewHostStatus(request, baseURL, host)).toBe(502)
})
