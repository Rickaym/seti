import type { Page } from '@playwright/test'
import type { StartAgentInput } from '@seti/shared'
import { codexOff, codexReady, codexStandIn, PINNED_CODEX } from './support/codex.js'
import { expect, test } from './support/fixtures.js'

test.use({ allowedHttpStatuses: [409], failureToasts: true })

/** Holds the start request and answers it with a refusal, so no Codex session ever starts. */
async function catchStart(page: Page): Promise<() => StartAgentInput | null> {
  let sent: StartAgentInput | null = null
  await page.route('**/api/tasks/start', async (route) => {
    sent = route.request().postDataJSON() as StartAgentInput
    await route.fulfill({ status: 409, json: { error: 'Held by the test' } })
  })
  return () => sent
}

test('the start page offers Codex only while it is ready with a key, with its model and effort', async ({
  page,
  request,
}) => {
  await codexOff(request)
  try {
    await page.goto('/#agents/new')
    const main = page.getByRole('main')
    await expect(main.getByLabel('Message')).toBeVisible()
    await expect(main.getByRole('button', { name: 'Codex', exact: true })).toHaveCount(0)

    await request.put('/api/runtimes/codex', { data: { enabled: true, program: codexStandIn(PINNED_CODEX) } })
    await page.reload()
    await expect(main.getByLabel('Message')).toBeVisible()
    await expect(
      main.getByRole('button', { name: 'Codex', exact: true }),
      'no key in the default credential',
    ).toHaveCount(0)

    await codexReady(request)
    await page.reload()
    const codex = main.getByRole('button', { name: 'Codex', exact: true })
    await expect(codex).toHaveAttribute('aria-pressed', 'false')
    await expect(main.getByRole('button', { name: 'Sandbox', exact: true })).toBeVisible()
    await codex.click()
    await expect(codex).toHaveAttribute('aria-pressed', 'true')
    await expect(main.getByRole('combobox', { name: 'Model' })).toHaveValue('gpt-5.5')
    await main.getByRole('combobox', { name: 'Effort' }).selectOption('high')
    await expect(main.getByRole('button', { name: 'Sandbox', exact: true })).toHaveCount(0)
    await expect(main.getByText('Codex: sandboxed, asks before every command and edit.')).toBeVisible()

    const sent = await catchStart(page)
    await main.getByLabel('Message').fill('Run the tests')
    await main.getByRole('button', { name: 'Start agent' }).click()
    await expect.poll(sent).toMatchObject({ runtime: 'codex', model: 'gpt-5.5', effort: 'high' })
    expect(sent()?.sandbox).toBeUndefined()
  } finally {
    await codexOff(request)
  }
})
