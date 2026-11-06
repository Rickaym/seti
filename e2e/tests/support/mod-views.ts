import fs from 'node:fs'
import path from 'node:path'
import type { APIRequestContext, FrameLocator, Page, Request } from '@playwright/test'
import { setModEnabled } from './mods.js'
import { seedViewerAgent } from './viewer-files.js'

/** The test mod whose views Seti serves in sandboxed frames. */
const VIEW_MOD = 'view-test'

/** What the views do on purpose: refusals their pages provoke and the calls Seti refuses. */
export const VIEW_VIOLATIONS = [/^(connect-src|img-src|form-action|frame-src|script-src-attr|script-src-elem) /]
export const VIEW_CONSOLE_ERRORS = [
  /Content Security Policy|Refused to|Blocked (?:opening|form submission|script execution)|Unsafe attempt|sandboxed|webrtc|Failed to load resource|ERR_BLOCKED_BY_CSP|WebSocket connection/,
]
export const VIEW_HTTP_STATUSES = [403, 404]

export async function viewModOn(request: APIRequestContext): Promise<void> {
  await setModEnabled(request, VIEW_MOD, true)
}

export async function viewModOff(request: APIRequestContext): Promise<void> {
  await request.patch(`/api/mods/${VIEW_MOD}`, { data: { enabled: false } })
}

/** The region Seti draws around a view of the test mod. */
export const viewRegion = (page: Page, title: string) => page.getByRole('region', { name: `View test mod: ${title}` })

export const viewFrame = (page: Page, title: string): FrameLocator =>
  page.frameLocator(`iframe[title="View test: ${title}"]`)

/** An idle agent with a file the test mod's viewer shows. */
export async function seedViewTestAgent(): Promise<{ id: string; dir: string }> {
  const agent = await seedViewerAgent(10)
  fs.writeFileSync(path.join(agent.dir, 'docs', 'plan.viewtest'), 'ship it\n')
  return agent
}

/** How each request a frame made to Seti's API ended: its failure, or the status it got. */
export function framedApiOutcomes(page: Page): Map<Request, string> {
  const outcomes = new Map<Request, string>()
  const api = (request: Request) =>
    request.frame() !== page.mainFrame() && new URL(request.url()).pathname === '/api/tasks'
  page.on('request', (request) => {
    if (api(request)) {
      outcomes.set(request, 'pending')
    }
  })
  page.on('requestfailed', (request) => {
    if (outcomes.has(request)) {
      outcomes.set(request, request.failure()?.errorText ?? 'failed')
    }
  })
  page.on('response', (response) => {
    if (outcomes.has(response.request())) {
      outcomes.set(response.request(), `answered ${String(response.status())}`)
    }
  })
  return outcomes
}
