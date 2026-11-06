import {
  expectInsideRows,
  expectMarkers,
  markPage,
  resetBlobs,
  rowsOf,
  samePage,
  seedBlobAgents,
  setBlobSettings,
  SIZE_PX,
  switchBlobs,
} from './support/blobs.js'
import { expect, test } from './support/fixtures.js'
import { setModEnabled } from './support/mods.js'
import { expectFitsPhone } from './support/phone-layout.js'

test.afterEach(async ({ request }) => {
  await resetBlobs(request)
})

test('on a phone, rows show bookmark blobs with the same names and height, and toggle live', async ({ page }) => {
  const agents = await seedBlobAgents()
  await page.goto('/#agents')
  await markPage(page)
  await expectMarkers(page, agents, false)
  const rows = await rowsOf(page, agents)

  await switchBlobs(page, true)
  await expectMarkers(page, agents, true)
  expect(await rowsOf(page, agents)).toEqual(rows)
  await expectInsideRows(page, agents, SIZE_PX.Medium.coarse)
  await expectFitsPhone(page, 'agent list with blobs')

  await switchBlobs(page, false)
  await expectMarkers(page, agents, false)
  expect(await samePage(page)).toBe(true)
})

test('every size stays whole inside its row down to a 320 px screen', async ({ page, request }) => {
  const agents = await seedBlobAgents()
  await page.goto('/#agents')
  const rows = await rowsOf(page, agents)
  await setModEnabled(request, 'blobs', true)
  const width = page.viewportSize()?.width ?? 0
  for (const viewport of [width, 320]) {
    await page.setViewportSize({ width: viewport, height: page.viewportSize()?.height ?? 800 })
    for (const size of ['Small', 'Medium', 'Large'] as const) {
      await setBlobSettings(request, { size })
      await page.reload()
      await expectMarkers(page, agents, true)
      await expectInsideRows(page, agents, SIZE_PX[size].coarse)
      if (viewport === width) {
        expect(await rowsOf(page, agents)).toEqual(rows)
      }
      await expectFitsPhone(page, `agent list with ${size} blobs at ${String(viewport)} px`)
    }
  }
})
