import type { APIRequestContext, Locator, Page } from '@playwright/test'
import type { Envelope, Task } from '@seti/shared'
import { paths } from './env.js'
import { apiData, expect } from './fixtures.js'

/** Starts an unsandboxed agent on the fake Claude Code and waits for its first turn to end. */
export async function startIdleAgent(request: APIRequestContext, title: string): Promise<string> {
  const response = await request.post('/api/tasks', {
    data: { title, prompt: `Please greet as ${title}`, cwd: paths.checkout, sandbox: false },
  })
  expect(response.ok(), 'POST /api/tasks').toBe(true)
  const { id } = ((await response.json()) as Envelope<Task>).data
  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${id}`)).status).toBe('idle')
  return id
}

/** A terminal shown alone, as the main view. */
export const terminalIn = (scope: Page | Locator) => scope.getByRole('region', { name: 'Terminal', exact: true })

/** A terminal tile in the agent grid. */
export const tileIn = (page: Page, name = 'Terminal') =>
  page.getByRole('region', { name: `Terminal tile: ${name}`, exact: true })

/** What a terminal, alone or in a tile, shows, as xterm renders its rows. */
export const screenOf = (scope: Locator) => scope.locator('.xterm-rows')

/** The input line a touch screen types into a terminal through. */
export const terminalInput = (scope: Locator) => scope.getByRole('textbox', { name: 'Shell input', exact: true })

/** Types a command line into a terminal once its shell prompts, and presses Enter. */
export async function run(scope: Locator, command: string): Promise<void> {
  await expect(scope.getByText('Connecting...')).toHaveCount(0)
  await expect(screenOf(scope)).toContainText('$ ')
  const line = terminalInput(scope)
  const input = (await line.count()) > 0 ? line : scope.locator('.xterm-helper-textarea')
  await input.focus()
  await input.pressSequentially(command)
  await input.press('Enter')
}

/** The last number printed after `marker-`, as `echo pid-$$` prints it. */
async function lastMark(rows: Locator, marker: string): Promise<string> {
  const text = (await rows.textContent()) ?? ''
  const found = [...text.matchAll(new RegExp(`${marker}-(\\d+)`, 'gu'))].map((match) => match[1] ?? '')
  return found.at(-1) ?? ''
}

/** The pid of the shell a terminal shows, as `echo pid-$$` printed it last. */
export const shellPid = async (rows: Locator) => lastMark(rows, 'pid')

let asked = 0

/** Asks the shell for its rows, as full-screen programs see them, and returns them. */
export async function shellRows(scope: Locator): Promise<number> {
  asked += 1
  const marker = `rows${String(asked)}x`
  await run(scope, `echo ${marker}-$(stty size | cut -d" " -f1)`)
  await expect.poll(async () => lastMark(screenOf(scope), marker)).not.toBe('')
  return Number(await lastMark(screenOf(scope), marker))
}

/** The rows xterm draws and how many of them fit the host it fills. */
export async function screenRows(scope: Locator): Promise<{ drawn: number; fit: number }> {
  return scope.locator('.xterm').evaluate((xterm) => {
    const host = xterm.parentElement
    const row = xterm.querySelector('.xterm-rows > div')
    const drawn = xterm.querySelectorAll('.xterm-rows > div').length
    const height = row?.getBoundingClientRect().height ?? 1
    return { drawn, fit: Math.floor((host?.clientHeight ?? 0) / height) }
  })
}

/** The terminal button in the desktop sidebar. */
export const terminalButton = (page: Page) =>
  page.getByRole('complementary', { name: 'Sidebar' }).getByRole('button', { name: 'Terminal' })

/** Picks a terminal, or a new one, from the alone view's switcher. */
export async function switchTo(page: Page, terminal: Locator, name: string): Promise<void> {
  await terminal.getByRole('button', { name: 'Switch terminal' }).click()
  await page.getByRole('menuitem', { name, exact: true }).click()
}

/** Everything the page sends the shell as typed input. */
export function typedInput(page: Page): string[] {
  const sent: string[] = []
  page.on('websocket', (socket) => {
    socket.on('framesent', ({ payload }) => {
      if (typeof payload !== 'string') {
        return
      }
      const message = JSON.parse(payload) as { type?: string; data?: string }
      if (message.type === 'input' && typeof message.data === 'string') {
        sent.push(message.data)
      }
    })
  })
  return sent
}
