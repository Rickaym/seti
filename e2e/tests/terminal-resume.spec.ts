import type { Page, WebSocket as PageSocket } from '@playwright/test'
import { expect, test } from './support/fixtures.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'
import { run, screenOf, terminalButton, terminalIn } from './support/terminal.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

/** Keeps the page's terminal sockets reachable, so a test can drop one as a network blip does. */
async function trackSockets(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const Native = window.WebSocket
    const sockets: WebSocket[] = []
    Reflect.set(window, 'terminalSockets', sockets)
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        sockets.push(this)
      }
    }
  })
}

/** Output bytes each terminal socket received, in the order the page opened them. */
function outputBytes(page: Page): number[] {
  const bytes: number[] = []
  page.on('websocket', (socket: PageSocket) => {
    if (!socket.url().includes('/api/terminals/')) {
      return
    }
    const index = bytes.push(0) - 1
    socket.on('framereceived', ({ payload }) => {
      if (typeof payload !== 'string') {
        bytes[index] = (bytes[index] ?? 0) + payload.length
      }
    })
  })
  return bytes
}

test('a terminal that loses its socket picks up where it was, without a replay or a jump', async ({ page }) => {
  await trackSockets(page)
  const bytes = outputBytes(page)
  await page.goto('/#settings')
  await terminalButton(page).click()
  const terminal = terminalIn(page)
  await run(terminal, 'seq 1 400; echo marker-$((3*3))')
  await expect(screenOf(terminal)).toContainText('marker-9')
  expect(bytes).toHaveLength(1)

  const box = await terminal.locator('.xterm-screen').boundingBox()
  await page.mouse.move((box?.x ?? 0) + 200, (box?.y ?? 0) + 200)
  await page.mouse.wheel(0, -2000)
  const topRow = screenOf(terminal).locator('> div').first()
  await expect(topRow).not.toHaveText('')
  await expect.poll(async () => Number(await topRow.innerText())).toBeLessThan(380)
  const scrolledTo = await topRow.innerText()

  await page.evaluate(() => {
    const sockets = Reflect.get(window, 'terminalSockets') as WebSocket[]
    sockets.at(-1)?.close()
  })
  await expect.poll(() => bytes.length).toBe(2)
  await expect(terminal.getByText('Connecting...')).toHaveCount(0)
  await expect(topRow, 'the screen keeps its place').toHaveText(scrolledTo)
  expect(bytes[1], 'the server sends nothing it already sent').toBeLessThan(200)

  await page.mouse.wheel(0, 50_000)
  await expect(screenOf(terminal)).toContainText('marker-9')
  await run(terminal, 'echo after-$((4+4))')
  await expect(screenOf(terminal)).toContainText('after-8')
  await expect(screenOf(terminal).getByText('marker-9', { exact: true })).toHaveCount(1)
})
