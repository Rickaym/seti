import type { APIRequestContext, Locator, Page } from '@playwright/test'
import { bookmarkOf, seedBlobAgents, type BlobAgent } from './blobs.js'
import { openSeedDb } from './db.js'
import { expect } from './fixtures.js'
import { setModEnabled } from './mods.js'

/** A colour dark enough to need an edge on a dark page. */
const NIGHT = '#141821'

/** A blob's colours as the page paints them: its body, its eyes and the edge round its body. */
interface Paint {
  body: string
  face: string
  edge: string
}

async function paintOf(bookmark: Locator): Promise<Paint> {
  return bookmark.evaluate((node) => {
    const skin = node.querySelector('.skin')
    const eye = node.querySelector('.seti-blob-look .fill, .seti-blob-look .line')
    if (skin === null || eye === null) {
      throw new Error('blob has no body or eyes')
    }
    const [body, face] = [getComputedStyle(skin), getComputedStyle(eye)]
    const edge = body.stroke === 'none' ? 'none' : body.strokeWidth
    return { body: body.fill, face: eye.classList.contains('fill') ? face.fill : face.stroke, edge }
  })
}

/** Paint for each agent, in order, once the page shows the scheme. */
async function paintIn(page: Page, scheme: 'light' | 'dark', agents: readonly BlobAgent[]): Promise<Paint[]> {
  await page.emulateMedia({ colorScheme: scheme })
  await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${scheme}\\b`))
  return Promise.all(agents.map(async (agent) => paintOf(bookmarkOf(page, agent))))
}

/** The seeded agents this check paints: one in a preset colour, one with none, one near black. */
async function seedPainted(): Promise<{ coloured: BlobAgent; plain: BlobAgent; night: BlobAgent }> {
  const agents = await seedBlobAgents()
  const coloured = agents.find((agent) => agent.label === 'running')
  const plain = agents.find((agent) => !agent.colored)
  const night = agents.find((agent) => agent.label === 'idle')
  if (coloured === undefined || plain === undefined || night === undefined) {
    throw new Error('blob agents not seeded')
  }
  const db = openSeedDb()
  await db.run('UPDATE task SET color = ? WHERE id = ?', NIGHT, night.id)
  await db.close()
  return { coloured, plain, night }
}

/**
 * Checks blobs paint the same body and face in light and dark mode, in the agent's own colour or
 * the grey, and that only a near-black body gains an edge, on the dark page.
 */
export async function expectSamePaintInBothThemes(page: Page, request: APIRequestContext): Promise<void> {
  const { coloured, plain, night } = await seedPainted()
  await setModEnabled(request, 'blobs', true)
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto('/#agents')
  const agents = [coloured, plain, night]
  await expect(bookmarkOf(page, coloured)).toBeVisible()
  const light = await paintIn(page, 'light', agents)
  const dark = await paintIn(page, 'dark', agents)

  expect(light[0]?.body).toBe('rgb(84, 136, 236)')
  expect(light[2]?.body).toBe('rgb(20, 24, 33)')
  expect(light.map(({ body, face }) => ({ body, face }))).toEqual(dark.map(({ body, face }) => ({ body, face })))
  expect(new Set(light.map((paint) => paint.face)).size).toBe(3)
  expect(light.map((paint) => paint.edge)).toEqual(['none', 'none', 'none'])
  expect(dark.map((paint) => paint.edge)).toEqual(['none', 'none', '2px'])
}
