import type { Page } from '@playwright/test'
import type { WorkspaceEntry } from '@seti/shared'
import { newPage, openContext, shoot, type Device, type Theme } from './capture.js'
import { showHostsAs } from './channel-mocks.js'
import { SHOTS_SERVER_ENV } from './clock.js'
import { Encoder } from './encoder.js'
import { seedExtras } from './extras.js'
import { playGraphics } from './play.js'
import * as scenes from './scenes.js'
import { AGENTS, seedAgents, stampShares } from './seed.js'
import { startSources } from './sources.js'
import { apiData, test } from '../tests/support/fixtures.js'
import { setSharing, shareByApi } from '../tests/support/shares.js'

/** Each frame of the README: its file name, the device it shows and how to reach it. */
const FRAMES: [name: string, device: Device, scene: (page: Page) => Promise<void>][] = [
  ['channels', 'desktop', scenes.channels],
  ['phone-channels', 'phone', scenes.phoneChannels],
  ['security', 'desktop', scenes.security],
  ['home', 'desktop', scenes.home],
  ['mods', 'desktop', scenes.mods],
  ['agents-grid', 'desktop', scenes.grid],
  ['pull-request', 'desktop', scenes.pullRequest],
  ['files', 'desktop', scenes.files],
  ['phone-ea', 'phone', scenes.phoneEa],
  ['group-chat', 'desktop', scenes.groupChat],
  ['phone-agents', 'phone', scenes.phoneList],
  ['phone-permission', 'phone', scenes.phonePermission],
]

const THEMES: Theme[] = ['light', 'dark']

test.use({ serverEnv: SHOTS_SERVER_ENV })

/** SETI_SHOTS_ONLY=channels retakes only the README frames whose names contain it. */
const ONLY = process.env.SETI_SHOTS_ONLY ?? ''

test('README screenshots and Play listing graphics', async ({ browser, request, baseURL }) => {
  const base = baseURL ?? ''
  await seedAgents()
  const sources = await startSources()
  await seedExtras(request, base, sources)
  showHostsAs(sources.replacements())
  await sources.close()
  const [workspace] = await apiData<WorkspaceEntry[]>(request, '/workspaces')
  const panel = (i: string, agent: string, x: number, y: number) => ({ i, agent, x, y, w: 6, h: 12 })
  const panels = [
    panel('a', AGENTS.checkout, 0, 0),
    panel('b', AGENTS.orders, 6, 0),
    panel('c', AGENTS.infra, 0, 12),
    panel('d', AGENTS.cart, 6, 12),
  ]
  await request.put(`/api/mods/grid/layouts/${workspace?.id ?? ''}`, {
    data: { layout: { panels, locked: false, perScreen: null } },
  })
  await setSharing(request, true)
  const shareUrl = await shareByApi(request, AGENTS.guide, 'migration-v2.md')
  await stampShares()

  const encoder = await Encoder.open(browser)
  for (const theme of THEMES) {
    for (const [name, device, scene] of FRAMES.filter(([frame]) => frame.includes(ONLY))) {
      const context = await openContext(browser, base, { device, theme })
      const page = await newPage(context)
      await scene(page)
      await shoot(page, encoder, name, { device, theme })
      await context.close()
    }
    const viewer = await openContext(browser, base, { device: 'phone', theme, signedIn: false })
    const page = await viewer.newPage()
    await page.goto(shareUrl)
    await shoot(page, encoder, 'phone-share', { device: 'phone', theme })
    await viewer.close()
  }
  if (ONLY === '') {
    await playGraphics(browser, base, encoder)
  }
  await encoder.close()
})
