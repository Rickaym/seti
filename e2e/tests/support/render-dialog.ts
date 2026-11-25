import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect } from './fixtures.js'

/** An agent-made dashboard whose script writes text and draws a chart, to show it ran. */
const DASHBOARD = `<!doctype html>
<html><head><meta charset="utf-8"><title>Dashboard</title>
<style>body { font: 16px system-ui; margin: 24px } #out { font-size: 28px; color: rgb(20, 90, 160) }
canvas { max-width: 100% }</style></head>
<body><h2>Weekly builds</h2><p id="out">Waiting for the script</p><canvas id="chart" width="320" height="120"></canvas>
<script>document.getElementById('out').textContent = 'Drawn by its script'
var g = document.getElementById('chart').getContext('2d')
g.fillStyle = 'rgb(20, 90, 160)'
;[40, 90, 65, 110, 80].forEach(function (h, i) { g.fillRect(16 + i * 60, 120 - h, 40, h) })</script></body></html>
`

export const RENDER_LINE =
  "Runs this page's scripts in the visitor's browser, isolated from Seti. The page can still reach the internet."

export const CODE_LINE = 'Visitors see the file as code.'

/** Writes the dashboard beside the agent's other docs. */
export function seedDashboard(dir: string): void {
  fs.writeFileSync(path.join(dir, 'docs', 'dashboard.html'), DASHBOARD)
}

/** The rendered page's frame, where the dashboard's script wrote its text. */
export async function expectRenderedDashboard(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: 'dashboard.html' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'View code', exact: true })).toBeVisible()
  const frame = page.frameLocator('iframe[title="dashboard.html"]')
  await expect(frame.locator('#out')).toHaveText('Drawn by its script')
  await expect(page.locator('script')).toHaveCount(0)
}

/** The code view: the file's source as text, no frame and no script. */
export async function expectDashboardCode(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: 'dashboard.html' })).toBeVisible()
  await expect(page.getByText('Waiting for the script').first()).toBeVisible()
  await expect(page.locator('iframe')).toHaveCount(0)
  await expect(page.locator('script')).toHaveCount(0)
}
