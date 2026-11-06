import fs from 'node:fs'
import path from 'node:path'
import { apiData, expect, test } from './support/fixtures.js'
import { resetSampleMod, sampleToggle, setModEnabled } from './support/mods.js'
import { filesPanel, openViewerFile, seedViewerAgent } from './support/viewer-files.js'

test.afterEach(async ({ request }) => {
  await resetSampleMod(request)
})

test('a mod turned on adds its section, status item, settings page and viewer, and leaves no trace off', async ({
  page,
  request,
}) => {
  await page.goto('/#settings/mods/sample/permissions')
  const main = page.getByRole('main')
  await expect(main.getByRole('list', { name: 'What Sample may do' })).toContainText(
    'Keeps up to 1 MB of its own data in Seti.',
  )
  await main.getByRole('button', { name: 'Back to mods' }).click()
  await expect(main.getByRole('heading', { name: 'Mods', level: 2 })).toBeVisible()
  const sections = page.getByRole('navigation', { name: 'Sections' })
  const settingsNav = main.getByRole('navigation', { name: 'Settings pages' })
  const footer = page.getByRole('contentinfo')
  await expect(sampleToggle(page)).toHaveAttribute('aria-pressed', 'false')
  await expect(sections.getByRole('button', { name: 'Sample' })).toHaveCount(0)

  await sampleToggle(page).click()
  await expect(sampleToggle(page)).toHaveAttribute('aria-pressed', 'true')
  await expect(sections.getByRole('button', { name: 'Sample' })).toBeVisible()
  await expect(footer).toContainText('Sample on')

  await settingsNav.getByRole('button', { name: 'Sample' }).click()
  await expect(main.getByRole('heading', { name: 'Sample', level: 2 })).toBeVisible()
  const greeting = main.getByRole('textbox', { name: 'Greeting' })
  await greeting.fill('Good morning')
  await greeting.blur()
  await main.getByRole('button', { name: 'Loud', exact: true }).click()
  await expect(main.getByRole('button', { name: 'Loud', exact: true })).toHaveAttribute('aria-pressed', 'true')

  await sections.getByRole('button', { name: 'Sample' }).click()
  await expect(main.getByText('GOOD MORNING')).toBeVisible()
  await main.getByRole('button', { name: 'Count', exact: true }).click()
  await expect(main.getByText('Counted 1')).toBeVisible()
  const audit = await apiData<{ events: { actor: string }[] }>(request, '/audit?kind=mod.sample.counted')
  expect(audit.events[0]?.actor).toBe('mod:sample')

  await page.goto('/#settings/mods')
  await sampleToggle(page).click()
  await expect(sampleToggle(page)).toHaveAttribute('aria-pressed', 'false')
  await expect(sections.getByRole('button', { name: 'Sample' })).toHaveCount(0)
  await expect(settingsNav.getByRole('button', { name: 'Sample' })).toHaveCount(0)
  await expect(footer).not.toContainText('Sample on')
})

test("a mod's viewer and fence show what it adds, and once it is off a line offers to turn it on", async ({
  page,
  request,
}) => {
  const { id, dir } = await seedViewerAgent(10)
  fs.writeFileSync(path.join(dir, 'docs', 'plan.samplenote'), 'ship it\n')
  fs.writeFileSync(path.join(dir, 'docs', 'fence.md'), '# Fence\n\n```sample\nhello fence\n```\n')
  await setModEnabled(request, 'sample', true)
  await page.goto(`/#agents/${id}`)
  await page.getByRole('button', { name: 'Files', exact: true }).click()
  await openViewerFile(page, 'plan.samplenote')
  const panel = filesPanel(page)
  await expect(panel.getByText('Sample notes: plan.samplenote')).toBeVisible()
  await expect(panel.getByText('SHIP IT', { exact: true })).toBeVisible()
  await expect(panel.getByText(/^8 bytes, (dark|light) theme$/)).toBeVisible()
  await panel.getByRole('button', { name: 'Source' }).click()
  await expect(panel.getByText('ship it', { exact: true })).toBeVisible()
  await expect(panel.getByText('SHIP IT', { exact: true })).toHaveCount(0)
  await openViewerFile(page, 'fence.md')
  await expect(panel.getByText('Sample fence: HELLO FENCE')).toBeVisible()

  await setModEnabled(request, 'sample', false)
  await page.reload()
  await page.getByRole('button', { name: 'Files', exact: true }).click()
  await openViewerFile(page, 'fence.md')
  await expect(panel.locator('pre').filter({ hasText: 'hello fence' })).toBeVisible()
  await expect(panel.getByText('Sample fence: HELLO FENCE')).toHaveCount(0)
  await openViewerFile(page, 'plan.samplenote')
  await expect(panel.getByText('ship it', { exact: true })).toBeVisible()
  await expect(panel.getByText('Sample notes: plan.samplenote')).toHaveCount(0)
  const note = panel.getByRole('note').filter({ hasText: 'Sample shows these files.' })
  await note.getByRole('button', { name: 'Turn on' }).click()
  await expect(panel.getByText('SHIP IT', { exact: true })).toBeVisible()
  await expect(note).toHaveCount(0)
})

test("a file's viewer is Seti's own while no mod shows it, and a page preview needs a page viewer", async ({
  page,
  request,
}) => {
  const { id, dir } = await seedViewerAgent(10)
  fs.writeFileSync(path.join(dir, 'docs', 'notes.txt'), 'plain words\n')
  await page.goto(`/#agents/${id}`)
  await page.getByRole('button', { name: 'Files', exact: true }).click()
  await openViewerFile(page, 'notes.txt')
  const panel = filesPanel(page)
  await expect(panel.getByText('plain words')).toBeVisible()
  await expect(panel.getByRole('note')).toHaveCount(0)
  const query = new URLSearchParams({ root: 'cwd', path: 'docs/notes.txt', preview: '1' })
  const refused = await request.get(`/api/tasks/${id}/files/raw?${query.toString()}`, {
    headers: { 'sec-fetch-dest': 'iframe' },
  })
  expect(refused.status()).toBe(403)
})
