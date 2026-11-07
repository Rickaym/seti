import type { Page } from '@playwright/test'
import { newPage, openContext, shoot, type Device, type Theme } from './capture.js'
import { showHostsAs } from './channel-mocks.js'
import { SHOTS_SERVER_ENV } from './clock.js'
import { eaAsleep, eaListening, eaSpeaking } from './ea-call.js'
import { Encoder } from './encoder.js'
import { seedExtras } from './extras.js'
import { playGraphics } from './play.js'
import * as scenes from './scenes.js'
import { AGENTS, seedAgents, stampShares } from './seed.js'
import { startSources } from './sources.js'
import { gridTerminal, phoneTerminal, seedTerminalHome } from './terminal.js'
import { test } from '../tests/support/fixtures.js'
import { setSharing, shareByApi } from '../tests/support/shares.js'

/** Each frame of the README: its file name, the device it shows and how to reach it. */
const FRAMES: [name: string, device: Device, scene: (page: Page) => Promise<void>][] = [
  ['agents-grid', 'desktop', gridTerminal],
  ['home', 'desktop', scenes.home],
  ['channels', 'desktop', scenes.channels],
  ['phone-agents', 'phone', scenes.phoneList],
  ['phone-permission', 'phone', scenes.phonePermission],
  ['phone-terminal', 'phone', phoneTerminal],
  ['ea-listening', 'desktop', eaListening],
  ['phone-ea-speaking', 'phone', eaSpeaking],
  ['phone-ea-asleep', 'phone', eaAsleep],
]

const THEMES: Theme[] = ['light', 'dark']

test.use({ serverEnv: SHOTS_SERVER_ENV })

/** SETI_SHOTS_ONLY=channels retakes only the README frames whose names contain it. */
const ONLY = process.env.SETI_SHOTS_ONLY ?? ''

test('README screenshots and Play listing graphics', async ({ browser, request, baseURL }) => {
  const base = baseURL ?? ''
  await seedAgents()
  seedTerminalHome()
  const sources = await startSources()
  await seedExtras(request, base, sources)
  showHostsAs(sources.replacements())
  await sources.close()
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
