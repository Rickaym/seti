import type { Page } from '@playwright/test'
import type { StartAgentInput } from '@seti/shared'
import { codexOff, codexReady, codexStandIn, PINNED_CODEX } from './support/codex.js'
import { expect, test } from './support/fixtures.js'

test.use({ allowedHttpStatuses: [409], failureToasts: true })

const CODEX_HINT = 'Codex: sandboxed, asks before every command and edit.'

/** Holds the start request and answers it with a refusal, so no agent or Codex session starts. */
async function catchStart(page: Page): Promise<() => StartAgentInput | null> {
  let sent: StartAgentInput | null = null
  await page.route('**/api/tasks/start', async (route) => {
    sent = route.request().postDataJSON() as StartAgentInput
    await route.fulfill({ status: 409, json: { error: 'Held by the test' } })
  })
  return () => sent
}

/** Opens the start page afresh, so it reads where the runtimes stand now. */
const startPage = async (page: Page) => {
  await page.goto('/#agents/new')
  await page.reload()
  const main = page.getByRole('main')
  await expect(main.getByLabel('Message')).toBeVisible()
  return main
}

test('the start page lists Codex models only while Codex is ready with a key', async ({ page, request }) => {
  await codexOff(request)
  try {
    let main = await startPage(page)
    await expect(main.getByRole('combobox', { name: 'Model' }), 'Claude Code has only its default').toHaveCount(0)
    await expect(main.getByText(CODEX_HINT)).toHaveCount(0)

    await request.put('/api/runtimes/codex', { data: { enabled: true, program: codexStandIn(PINNED_CODEX) } })
    main = await startPage(page)
    await expect(main.getByRole('combobox', { name: 'Model' }), 'no key in the default credential').toHaveCount(0)

    await codexReady(request)
    main = await startPage(page)
    const model = main.getByRole('combobox', { name: 'Model' })
    await expect(model).toHaveValue('claude:')
    const groups = model.locator('optgroup')
    expect(await groups.evaluateAll((all) => all.map((group) => group.getAttribute('label')))).toEqual([
      'Claude Code',
      'Codex',
    ])
    await expect(model.locator('option')).toHaveText(['Default', 'gpt-5.5'])
    await expect(main.getByRole('combobox', { name: 'Effort' })).toHaveCount(0)
  } finally {
    await codexOff(request)
  }
})

test('picking a Codex model hides the sandbox toggle and starts the agent on Codex', async ({ page, request }) => {
  await codexReady(request)
  try {
    const main = await startPage(page)
    const model = main.getByRole('combobox', { name: 'Model' })
    const sandbox = main.getByRole('button', { name: 'Sandbox', exact: true })
    await expect(sandbox).toBeVisible()
    await model.selectOption({ label: 'gpt-5.5' })
    await expect(sandbox).toHaveCount(0)
    await expect(main.getByText(CODEX_HINT)).toBeVisible()
    const effort = main.getByRole('combobox', { name: 'Effort' })
    await expect(effort.locator('option')).toHaveText(['Default', 'low', 'medium', 'high', 'xhigh', 'max'])
    await effort.selectOption('high')

    const sent = await catchStart(page)
    await main.getByLabel('Message').fill('Run the tests')
    await main.getByRole('button', { name: 'Start agent' }).click()
    await expect.poll(sent).toMatchObject({ runtime: 'codex', model: 'gpt-5.5', effort: 'high' })
    expect(sent()?.sandbox).toBeUndefined()

    await model.selectOption({ label: 'Default' })
    await expect(sandbox).toBeVisible()
    await expect(effort).toHaveCount(0)
    await expect(main.getByText(CODEX_HINT)).toHaveCount(0)
  } finally {
    await codexOff(request)
  }
})

test('the untouched selector starts on Claude Code with the same body as before', async ({ page, request }) => {
  await codexReady(request)
  try {
    const main = await startPage(page)
    await expect(main.getByRole('combobox', { name: 'Model' })).toHaveValue('claude:')
    const sent = await catchStart(page)
    await main.getByLabel('Message').fill('Tidy the README')
    await main.getByRole('button', { name: 'Start agent' }).click()
    await expect.poll(sent).toMatchObject({ prompt: 'Tidy the README' })
    expect(Object.keys(sent() ?? {}).filter((key) => ['runtime', 'model', 'effort', 'sandbox'].includes(key))).toEqual(
      [],
    )
  } finally {
    await codexOff(request)
  }
})
