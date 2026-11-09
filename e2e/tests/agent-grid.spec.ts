import type { APIRequestContext, Locator, Page } from '@playwright/test'
import { expect, loadAssetsThroughNode, test, unique } from './support/fixtures.js'
import {
  boxOf,
  focusedPanel,
  grid,
  items,
  mainGrid,
  panelOf,
  rectOf,
  startAgent,
  status,
  toolbar,
} from './support/grid.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

/** Lock, Tidy and Clear sit once, in a bar along the grid level with the list header. */
async function expectGridControlsInGridOnly(page: Page): Promise<void> {
  const bar = toolbar(page)
  for (const name of ['Lock', 'Tidy', 'Clear']) {
    await expect(bar.getByRole('button', { name, exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name, exact: true })).toHaveCount(1)
  }
  const header = page.getByRole('heading', { name: 'Agents', level: 1 }).locator('..')
  await expect(header.getByRole('button', { name: /Grid layout|Lock|Tidy|Clear/ })).toHaveCount(0)
  const [barBox, headerBox, gridBox] = await Promise.all([boxOf(bar), boxOf(header), boxOf(grid(page))])
  expect(barBox.x).toBeGreaterThanOrEqual(headerBox.x + headerBox.width - 1)
  expect(Math.abs(barBox.y - headerBox.y)).toBeLessThanOrEqual(1)
  expect(Math.abs(barBox.height - headerBox.height)).toBeLessThanOrEqual(1)
  expect(barBox.y + barBox.height).toBeLessThanOrEqual(gridBox.y + 1)
}

async function dragBy(page: Page, handle: Locator, dx: number, dy: number): Promise<void> {
  const box = await handle.boundingBox()
  if (box === null) {
    throw new Error('the drag handle is not on screen')
  }
  const x = box.x + Math.min(10, box.width / 2)
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + dx, y + dy, { steps: 12 })
  await page.mouse.up()
}

/** Opens two agents into the grid, side by side, the first on the left. */
async function twoSideBySide(page: Page, request: APIRequestContext, label: string) {
  const left = unique(`${label} left`)
  const right = unique(`${label} right`)
  const leftId = await startAgent(request, left)
  const rightId = await startAgent(request, right)
  await page.goto(`/#agents/${leftId}`)
  await page.getByRole('button', { name: 'Open in grid' }).click()
  await expect.poll(async () => rectOf(panelOf(page, left))).toEqual([0, 0, 12, 24])
  await page.goto(`/#agents/${rightId}`)
  await expect.poll(async () => rectOf(panelOf(page, right))).toEqual([6, 0, 6, 24])
  await expect.poll(async () => rectOf(panelOf(page, left))).toEqual([0, 0, 6, 24])
  return { left, right, leftId, rightId }
}

test('the grid toggles from the header, Alt+G, the palette and the list, with no presets left', async ({
  page,
  request,
}) => {
  const title = unique('Grid toggle')
  const id = await startAgent(request, title)
  await page.goto(`/#agents/${id}`)
  await expect(grid(page)).toHaveCount(0)

  await page.getByRole('button', { name: 'Open in grid' }).click()
  await expect(panelOf(page, title)).toHaveCount(1)
  await expect(focusedPanel(page).getByRole('heading', { name: title })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Grid', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('separator', { name: /^Resize (rows|columns)/ })).toHaveCount(0)

  await expectGridControlsInGridOnly(page)
  await expect(page.getByRole('button', { name: /^\d by \d$/ })).toHaveCount(0)

  await page.keyboard.press('Alt+g')
  await expect(grid(page)).toHaveCount(0)
  await expect(toolbar(page)).toHaveCount(0)
  for (const name of ['Lock', 'Tidy', 'Clear']) {
    await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0)
  }
  await expect(page.getByRole('main').getByRole('heading', { name: title })).toBeVisible()
  await page.keyboard.press('Control+k')
  await page.getByRole('combobox').fill('>agent grid')
  await page.keyboard.press('Enter')
  await expect(panelOf(page, title)).toHaveCount(1)

  await page.getByRole('button', { name: 'Grid', exact: true }).click()
  await expect(grid(page)).toHaveCount(0)
})

test('panels drag by the header and reflow into new rows, resize by the corner, and persist', async ({
  page,
  request,
}) => {
  test.setTimeout(60_000)
  const { left, right } = await twoSideBySide(page, request, 'Grid drag')
  const leftPanel = panelOf(page, left)
  const rightPanel = panelOf(page, right)
  const gridBox = await grid(page).boundingBox()
  const width = gridBox?.width ?? 1000

  await dragBy(page, leftPanel.getByTestId('agent-header'), width / 2, 40)
  await expect.poll(async () => rectOf(leftPanel)).toEqual([6, 0, 6, 24])
  await expect.poll(async () => (await rectOf(rightPanel))[1]).toBeGreaterThanOrEqual(24)
  await expect(status(page)).toContainText(`${left} moved to column 7 of 12, row 1`)

  const corner = leftPanel.locator('.react-resizable-handle-se')
  await leftPanel.hover()
  await dragBy(page, corner, -width / 6, -200)
  await expect.poll(async () => (await rectOf(leftPanel))[2]).toBeLessThan(6)
  await expect.poll(async () => (await rectOf(leftPanel))[3]).toBeLessThan(24)
  await expect(status(page)).toContainText(`${left} is now`)
  const settled = { left: await rectOf(leftPanel), right: await rectOf(rightPanel) }

  await page.reload()
  await expect.poll(async () => rectOf(panelOf(page, left))).toEqual(settled.left)
  await expect.poll(async () => rectOf(panelOf(page, right))).toEqual(settled.right)
  await expect(page.locator('[data-grid-panel]')).toHaveCount(2)
})

test('an agent dragged from the list lands where it is dropped and both stream', async ({ page, request }) => {
  test.setTimeout(60_000)
  const alpha = unique('Grid alpha')
  const beta = unique('Grid beta')
  const alphaId = await startAgent(request, alpha)
  const betaId = await startAgent(request, beta)
  await page.goto(`/#agents/${alphaId}`)
  await page.getByRole('button', { name: 'Open in grid' }).click()
  await expect.poll(async () => rectOf(panelOf(page, alpha))).toEqual([0, 0, 12, 24])

  const gridBox = await grid(page).boundingBox()
  await page
    .locator(`[data-task-id="${betaId}"] button`)
    .first()
    .dragTo(grid(page), { targetPosition: { x: 40, y: 40 } })
  await expect.poll(async () => (await rectOf(panelOf(page, beta)))[0]).toBe(0)
  await expect.poll(async () => (await rectOf(panelOf(page, beta)))[1]).toBe(0)
  await expect.poll(async () => (await rectOf(panelOf(page, alpha)))[1]).toBeGreaterThan(0)
  await expect(focusedPanel(page).getByRole('heading', { name: beta })).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`#agents/${betaId}$`))
  await expect(status(page)).toContainText(`${beta} placed at column 1 of 12, row 1`)
  expect(gridBox).not.toBeNull()

  for (const [title, text] of [
    [alpha, 'Alpha, report back'],
    [beta, 'Beta, report back'],
  ] as const) {
    const reply = panelOf(page, title).getByRole('combobox', { name: 'Reply' })
    await reply.click()
    await reply.fill(text)
    await page.keyboard.press('Enter')
    const transcript = panelOf(page, title).getByRole('region', { name: 'Transcript' })
    await expect(transcript.getByText(text)).toBeVisible()
    await expect(transcript.getByText('Done.', { exact: true })).toHaveCount(2)
  }
})

test('the keyboard moves and resizes panels, and announces each step', async ({ page, request }) => {
  test.setTimeout(60_000)
  const { left, right, rightId } = await twoSideBySide(page, request, 'Grid keys')

  await panelOf(page, right).getByRole('combobox', { name: 'Reply' }).focus()
  await expect(focusedPanel(page).getByRole('heading', { name: right })).toBeVisible()
  await expect(panelOf(page, right).getByRole('combobox', { name: 'Reply' })).toBeFocused()
  await expect(page).toHaveURL(new RegExp(`#agents/${rightId}$`))

  await page.keyboard.press('Alt+Shift+ArrowLeft')
  await expect.poll(async () => rectOf(panelOf(page, right))).toEqual([0, 0, 6, 24])
  await expect.poll(async () => rectOf(panelOf(page, left))).toEqual([6, 0, 6, 24])
  await expect(status(page)).toHaveText(`${right} moved left, to column 1 of 12, row 1`)
  await page.keyboard.press('Alt+Shift+ArrowLeft')
  await expect(status(page)).toHaveText(`${right} is already at the left edge`)

  await panelOf(page, right).getByRole('button', { name: 'More actions' }).click()
  await page.getByRole('menuitem', { name: 'Arrange' }).click()
  await expect(status(page)).toContainText(`Arranging ${right}.`)
  await page.keyboard.press('Shift+ArrowLeft')
  await expect.poll(async () => (await rectOf(panelOf(page, right)))[2]).toBe(5)
  await expect(status(page)).toHaveText(`${right} is now 5 columns wide, 24 rows tall`)
  await page.keyboard.press('Escape')
  await expect.poll(async () => rectOf(panelOf(page, right))).toEqual([0, 0, 6, 24])
  await expect(status(page)).toHaveText('Arranging cancelled')

  await page.keyboard.press('Control+k')
  await page.getByRole('combobox').fill('>arrange panel')
  await page.keyboard.press('Enter')
  await expect(status(page)).toContainText(`Arranging ${right}.`)
  await page.keyboard.press('ArrowRight')
  await expect.poll(async () => rectOf(panelOf(page, right))).toEqual([6, 0, 6, 24])
  await page.keyboard.press('Shift+ArrowUp')
  await expect.poll(async () => (await rectOf(panelOf(page, right)))[3]).toBe(23)
  await page.keyboard.press('Enter')
  await expect(status(page)).toHaveText('Layout kept')

  await page.keyboard.press('Alt+ArrowLeft')
  await expect(page).toHaveURL(new RegExp(`#agents/${rightId}$`))
  await page.reload()
  await expect.poll(async () => rectOf(panelOf(page, right))).toEqual([6, 0, 6, 23])
})

test('lock holds the layout, tidy evens it out, and clear empties it with undo', async ({ page, request }) => {
  test.setTimeout(60_000)
  const { left, right } = await twoSideBySide(page, request, 'Grid lock')
  const third = unique('Grid lock third')
  const thirdId = await startAgent(request, third)
  await page.goto(`/#agents/${thirdId}`)
  await expect(panelOf(page, third)).toHaveCount(1)

  const bar = toolbar(page)
  await expect(bar).toContainText('3 panels')
  const lock = bar.getByRole('button', { name: 'Lock', exact: true })
  await lock.click()
  await expect(lock).toHaveAttribute('aria-pressed', 'true')
  await expect(status(page)).toHaveText('Grid layout locked')
  const before = await rectOf(panelOf(page, left))
  await dragBy(page, panelOf(page, left).getByTestId('agent-header'), 400, 0)
  expect(await rectOf(panelOf(page, left))).toEqual(before)
  await expect(panelOf(page, left).locator('.react-resizable-handle:visible')).toHaveCount(0)
  await panelOf(page, left).getByRole('button', { name: 'More actions' }).click()
  await expect(page.getByRole('menuitem', { name: 'Arrange' })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await panelOf(page, left).getByRole('combobox', { name: 'Reply' }).focus()
  await page.keyboard.press('Alt+Shift+ArrowRight')
  await expect(status(page)).toHaveText('The grid layout is locked')

  await lock.click()
  await expect(lock).toHaveAttribute('aria-pressed', 'false')
  await bar.getByRole('button', { name: 'Tidy', exact: true }).click()
  await expect(status(page)).toHaveText('Tidied 3 panels to fit the window')
  const rects = await Promise.all([left, right, third].map(async (title) => rectOf(panelOf(page, title))))
  expect(Math.max(...rects.map(([, y, , h]) => (y ?? 0) + (h ?? 0)))).toBe(24)
  expect(rects.map(([x, y]) => [x, y])).toEqual([
    [0, 0],
    [4, 0],
    [8, 0],
  ])

  await bar.getByRole('button', { name: 'Clear', exact: true }).click()
  await expect(page.locator('[data-grid-panel]')).toHaveCount(0)
  await expect(grid(page).getByText('Drag agents here or pick one')).toBeVisible()
  await expect(bar).toContainText('No panels')
  await expect(bar.getByRole('button', { name: 'Tidy', exact: true })).toBeDisabled()
  await expect(bar.getByRole('button', { name: 'Clear', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(page.locator('[data-grid-panel]')).toHaveCount(3)
})

test('a grid stored as rows and columns comes back as panels in the same places', async ({ page, request }) => {
  const alpha = unique('Grid migrate alpha')
  const beta = unique('Grid migrate beta')
  const alphaId = await startAgent(request, alpha)
  const betaId = await startAgent(request, beta)
  await page.addInitScript(
    ([a, b]) => {
      if (localStorage.getItem('seti.agents.grid')?.includes('"v":4') === true) {
        return
      }
      const layout = { rows: 2, cols: 2, colSizes: [0.4, 0.6], rowSizes: [0.5, 0.5], cells: [a, null, null, b] }
      localStorage.setItem('seti.agents.grid', JSON.stringify({ enabled: true, layout, focused: 3, recent: [b] }))
    },
    [alphaId, betaId],
  )
  await page.goto('/#agents')
  await expect.poll(async () => rectOf(panelOf(page, alpha))).toEqual([0, 0, 5, 12])
  await expect.poll(async () => rectOf(panelOf(page, beta))).toEqual([5, 0, 7, 12])
  await expect(focusedPanel(page).getByRole('heading', { name: beta })).toBeVisible()
  await expect
    .poll(async () => (await mainGrid(request))?.layout.panels.map((panel) => panel.agent))
    .toEqual([alphaId, betaId])
  await page.reload()
  await expect.poll(async () => rectOf(panelOf(page, beta))).toEqual([5, 0, 7, 12])
  expect(await page.evaluate(() => localStorage.getItem('seti.agents.grid'))).toContain('"v":4')
})

test('a grid arranged in one browser opens the same in another, and changes there come back', async ({
  page,
  request,
  browser,
  baseURL,
}) => {
  test.setTimeout(60_000)
  const { left, right, rightId } = await twoSideBySide(page, request, 'Grid shared')
  await panelOf(page, right).getByRole('combobox', { name: 'Reply' }).focus()
  await page.keyboard.press('Alt+Shift+ArrowLeft')
  await expect.poll(async () => rectOf(panelOf(page, right))).toEqual([0, 0, 6, 24])
  await expect.poll(async () => (await mainGrid(request))?.layout.panels.find((p) => p.x === 0)?.agent).toBe(rightId)

  const other = await browser.newContext()
  await loadAssetsThroughNode(other, baseURL ?? '')
  const second = await other.newPage()
  await second.goto('/#agents')
  await expect(grid(second)).toHaveCount(0)
  await second.getByRole('button', { name: 'Grid', exact: true }).click()
  await expect.poll(async () => rectOf(panelOf(second, right))).toEqual([0, 0, 6, 24])
  await expect.poll(async () => rectOf(panelOf(second, left))).toEqual([6, 0, 6, 24])

  await toolbar(second).getByRole('button', { name: 'Lock', exact: true }).click()
  await panelOf(second, left).getByRole('button', { name: 'More actions' }).click()
  await second.getByRole('menuitem', { name: 'Remove from grid' }).click()
  await expect.poll(async () => (await mainGrid(request))?.layout).toMatchObject({ locked: true, panels: [{}] })
  await other.close()

  await expect(grid(page)).toHaveAttribute('data-locked', 'false')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(grid(page)).toHaveAttribute('data-locked', 'true')
  await expect(page.locator('[data-grid-panel]')).toHaveCount(1)
  await expect(panelOf(page, right)).toHaveCount(1)
})

test('Ctrl+F searches only the focused panel, and the panel menu swaps and removes agents', async ({
  page,
  request,
}) => {
  test.setTimeout(60_000)
  const { left, right, rightId } = await twoSideBySide(page, request, 'Grid find')
  await expect(focusedPanel(page).getByRole('heading', { name: right })).toBeVisible()

  await page.keyboard.press('Control+f')
  await expect(panelOf(page, right).getByTestId('chat-find')).toBeVisible()
  await expect(panelOf(page, left).getByTestId('chat-find')).toHaveCount(0)
  await page.keyboard.press('Escape')

  await panelOf(page, left).getByRole('heading', { name: left }).click()
  await expect(focusedPanel(page).getByRole('heading', { name: left })).toBeVisible()
  await page.keyboard.press('Control+f')
  await expect(panelOf(page, left).getByTestId('chat-find')).toBeVisible()
  await expect(panelOf(page, right).getByTestId('chat-find')).toHaveCount(0)
  await page.keyboard.press('Escape')

  const leftSlot = await rectOf(panelOf(page, left))
  await panelOf(page, left).getByRole('button', { name: 'More actions' }).click()
  await page.getByRole('menuitem', { name: 'Swap agent' }).click()
  await page.keyboard.type(right)
  await page.keyboard.press('Enter')
  await expect.poll(async () => rectOf(panelOf(page, right))).toEqual(leftSlot)

  await panelOf(page, left).getByRole('button', { name: 'More actions' }).click()
  await page.getByRole('menuitem', { name: 'Remove from grid' }).click()
  await expect(page.locator('[data-grid-panel]')).toHaveCount(1)
  await expect(status(page)).toHaveText(`Removed ${left} from the grid`)

  await panelOf(page, right).getByRole('button', { name: 'More actions' }).click()
  await page.getByRole('menuitem', { name: 'Open alone' }).click()
  await expect(grid(page)).toHaveCount(0)
  await expect(page).toHaveURL(new RegExp(`#agents/${rightId}$`))
})

test('Files and group chat float over the grid, Processes opens, and archiving empties a panel', async ({
  page,
  request,
}) => {
  test.setTimeout(60_000)
  const { left, right } = await twoSideBySide(page, request, 'Grid tools')

  await page.keyboard.press('Control+k')
  await page.getByRole('combobox').fill(left)
  await page.keyboard.press('Enter')
  await expect(focusedPanel(page).getByRole('heading', { name: left })).toBeVisible()
  await expect(panelOf(page, left).getByRole('combobox', { name: 'Reply' })).toBeFocused()

  const gridBox = await boxOf(grid(page))
  const openFiles = async () => {
    await panelOf(page, left).getByRole('button', { name: 'More actions' }).click()
    await page.getByRole('menuitem', { name: 'Files' }).click()
  }
  await openFiles()
  const files = page.getByRole('region', { name: 'Files', exact: true })
  await expect(files).toBeVisible()
  await expect(panelOf(page, left).getByRole('region', { name: 'Files', exact: true })).toHaveCount(0)
  await expect(page.getByRole('separator', { name: 'Resize files' })).toBeVisible()
  expect(await boxOf(grid(page))).toEqual(gridBox)
  const filesBox = await boxOf(files)
  expect(filesBox.x).toBeGreaterThan(gridBox.x)
  expect(filesBox.x + filesBox.width).toBeLessThanOrEqual(gridBox.x + gridBox.width + 1)
  await files.getByRole('button', { name: 'Close Files' }).click()
  await expect(files).toHaveCount(0)
  await openFiles()
  await expect(files).toBeVisible()
  await toolbar(page).getByText('2 panels').click()
  await expect(files).toHaveCount(0)

  await page.getByRole('button', { name: 'Group chat', exact: true }).first().click()
  const chat = page.getByTestId('team-chat-panel')
  await expect(chat).toBeVisible()
  expect(await boxOf(grid(page))).toEqual(gridBox)
  await toolbar(page).getByText('2 panels').click()
  await expect(chat).toHaveCount(0)

  await panelOf(page, right).getByRole('button', { name: 'More actions' }).click()
  await page.getByRole('menuitem', { name: 'Processes' }).click()
  await expect(page.getByRole('dialog').getByRole('heading', { name: 'Processes', level: 2 })).toBeVisible()
  await page.keyboard.press('Escape')

  const slot = await rectOf(panelOf(page, right))
  const cog = panelOf(page, right).getByRole('button', { name: 'Agent settings' })
  await expect(cog.getByText('Settings', { exact: true })).toBeHidden()
  await cog.click()
  await expect(page.getByRole('dialog').getByRole('group', { name: 'Lifecycle' })).toBeVisible()
  await page.getByRole('dialog').getByRole('button', { name: 'Archive', exact: true }).click()
  await page.getByRole('dialog', { name: 'Archive agent' }).getByRole('button', { name: 'Archive' }).click()
  const emptied = items(page).filter({ has: page.locator('[data-grid-empty]') })
  await expect(emptied.getByRole('combobox', { name: 'Pick an agent' })).toBeVisible()
  expect(await rectOf(emptied)).toEqual(slot)
  await expect(panelOf(page, left).getByRole('heading', { name: left })).toBeVisible()
})
