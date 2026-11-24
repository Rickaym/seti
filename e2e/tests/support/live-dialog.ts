import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect } from './fixtures.js'

/** An agent-made dashboard whose script draws its text, so the live page shows the script ran. */
const DASHBOARD = `<!doctype html>
<html><head><meta charset="utf-8"><title>Dashboard</title>
<style>body { font: 16px system-ui; margin: 24px } #out { font-size: 28px; color: rgb(20, 90, 160) }</style></head>
<body><h2>Weekly builds</h2><p id="out">Waiting for the script</p>
<script>document.getElementById('out').textContent = 'Drawn by its script'</script></body></html>
`

export const LIVE_LINE =
  "Runs this page's scripts in the visitor's browser, isolated from Seti. The page can still reach the internet."

/** Writes the dashboard beside the agent's other docs. */
export function seedDashboard(dir: string): void {
  fs.writeFileSync(path.join(dir, 'docs', 'dashboard.html'), DASHBOARD)
}

/** The live page's frame, where the dashboard's script wrote its text. */
export async function expectLiveDashboard(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: 'dashboard.html' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Static view' })).toBeVisible()
  const frame = page.frameLocator('iframe[title="dashboard.html"]')
  await expect(frame.locator('#out')).toHaveText('Drawn by its script')
  await expect(page.locator('script')).toHaveCount(0)
}

/** The static view: the file's source as text, no frame and no script. */
export async function expectStaticDashboard(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: 'dashboard.html' })).toBeVisible()
  await expect(page.getByText('Waiting for the script').first()).toBeVisible()
  await expect(page.locator('iframe')).toHaveCount(0)
  await expect(page.locator('script')).toHaveCount(0)
}
