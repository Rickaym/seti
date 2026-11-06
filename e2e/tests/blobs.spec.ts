import {
  animationsOf,
  bookmarkOf,
  expectInsideRows,
  expectMarkers,
  flipBlobSetting,
  markPage,
  pickBlobSetting,
  resetBlobs,
  rowsOf,
  samePage,
  seedBlobAgents,
  setBlobSettings,
  SIZE_PX,
  switchBlobs,
  titleStarts,
} from './support/blobs.js'
import { expect, test } from './support/fixtures.js'
import { setModEnabled } from './support/mods.js'

test.afterEach(async ({ request }) => {
  await resetBlobs(request)
})

test('Blobs puts a bookmark blob in place of each bar and marker, same names, and toggles live', async ({ page }) => {
  const agents = await seedBlobAgents()
  await page.goto('/#agents')
  await markPage(page)
  await expectMarkers(page, agents, false)
  const rows = await rowsOf(page, agents)

  await switchBlobs(page, true)
  await expectMarkers(page, agents, true)
  expect(await rowsOf(page, agents)).toEqual(rows)
  await expectInsideRows(page, agents, SIZE_PX.Medium.fine)
  const blocked = agents.find((agent) => agent.label === 'waits on you')
  const needsYou = page.getByRole('main').getByRole('region', { name: 'Needs you' })
  await expect(needsYou.locator(`[data-task-id="${blocked?.id ?? ''}"]`).getByTestId('blob-bookmark')).toBeVisible()

  const [running, ...still] = agents
  if (running === undefined) {
    throw new Error('no running agent seeded')
  }
  await expect.poll(async () => animationsOf(bookmarkOf(page, running))).toBe(2)
  for (const agent of still) {
    expect(await animationsOf(bookmarkOf(page, agent)), agent.label).toBe(0)
  }
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect.poll(async () => animationsOf(bookmarkOf(page, running))).toBe(0)
  await expect(bookmarkOf(page, running)).toHaveAttribute('data-expression', 'happy')
  await page.emulateMedia({ reducedMotion: null })

  await switchBlobs(page, false)
  await expectMarkers(page, agents, false)
  expect(await samePage(page)).toBe(true)
})

test('size applies live from the settings page, inside the row and at the same height', async ({ page }) => {
  const agents = await seedBlobAgents()
  const [first] = agents
  if (first === undefined) {
    throw new Error('no agent seeded')
  }
  await page.goto('/#agents')
  await markPage(page)
  const rows = await rowsOf(page, agents)
  await switchBlobs(page, true)
  for (const size of ['Small', 'Large', 'Medium'] as const) {
    await pickBlobSetting(page, 'Size', size)
    await expect(bookmarkOf(page, first)).toHaveAttribute('data-blob-size', size)
    await expectInsideRows(page, agents, SIZE_PX[size].fine)
    expect(await rowsOf(page, agents)).toEqual(rows)
  }
  expect(await samePage(page)).toBe(true)
})

test('animation off keeps running blobs still', async ({ page, request }) => {
  const [running] = await seedBlobAgents()
  if (running === undefined) {
    throw new Error('no running agent seeded')
  }
  await setModEnabled(request, 'blobs', true)
  await page.goto('/#agents')
  await expect.poll(async () => animationsOf(bookmarkOf(page, running))).toBe(2)
  await flipBlobSetting(page, 'Animation', false)
  await expect.poll(async () => animationsOf(bookmarkOf(page, running))).toBe(0)
  await expect(bookmarkOf(page, running)).toHaveAttribute('data-animate', 'false')
})

test('Needs you off brings back its bars and markers with titles still lined up', async ({ page, request }) => {
  const agents = await seedBlobAgents()
  await setModEnabled(request, 'blobs', true)
  await page.goto('/#agents')
  const starts = await titleStarts(page, agents)
  expect(new Set(starts).size).toBe(1)

  await flipBlobSetting(page, 'Needs you', false)
  const waiting = agents.filter((agent) => agent.label === 'waits on you')
  const rest = agents.filter((agent) => !waiting.includes(agent))
  await expectMarkers(page, waiting, false)
  await expectMarkers(page, rest, true)
  expect(await titleStarts(page, agents)).toEqual(starts)

  await flipBlobSetting(page, 'Agent list', false)
  await expectMarkers(page, agents, false)
  expect(await titleStarts(page, agents)).toEqual(starts)
})

test('the legend draws its statuses as blobs while the list shows them', async ({ page, request }) => {
  await setModEnabled(request, 'blobs', true)
  await page.goto('/#agents')
  const open = async () => {
    await page.getByRole('complementary', { name: 'Sidebar' }).getByRole('button', { name: 'Shortcuts' }).click()
    return page.getByRole('dialog', { name: 'Shortcuts' }).getByRole('region', { name: 'Agent status' })
  }
  await expect((await open()).getByTestId('status-blob')).toHaveCount(8)
  await page.keyboard.press('Escape')
  await setBlobSettings(request, { list: false })
  await page.reload()
  const legend = await open()
  await expect(legend.locator('[data-status-light] svg').filter({ visible: true })).toHaveCount(8)
  await expect(legend.getByTestId('status-blob')).toHaveCount(0)
})
