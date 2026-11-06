import { randomUUID } from 'node:crypto'
import type { Locator, Page } from '@playwright/test'
import type { Task } from '@seti/shared'
import { expandColors, openAgentSettings } from './support/agent-settings.js'
import { openSeedDb } from './support/db.js'
import { paths } from './support/env.js'
import { apiData, expect, test, unique } from './support/fixtures.js'

async function seedAgent(title: string): Promise<string> {
  const db = openSeedDb()
  const id = randomUUID()
  await db.idleTask(id, title, paths.checkout, new Date().toISOString())
  await db.close()
  return id
}

/** The stripe and tint the page fitted for an element's agent colour, as computed rgb(). */
async function inkOf(element: Locator): Promise<{ stripe: string; tint: string }> {
  return element.evaluate((el) => {
    const probe = document.createElement('span')
    el.append(probe)
    const read = (variable: string) => {
      probe.style.color = `var(${variable})`
      return getComputedStyle(probe).color
    }
    const ink = { stripe: read('--agent-stripe'), tint: read('--agent-tint') }
    probe.remove()
    return ink
  })
}

const stripeOf = async (element: Locator) => element.evaluate((el) => getComputedStyle(el).backgroundImage)
const frameOf = async (element: Locator) => element.evaluate((el) => getComputedStyle(el, '::after').borderTopColor)

async function openColours(page: Page): Promise<Locator> {
  const dialog = await openAgentSettings(page)
  await expandColors(dialog)
  return dialog
}

async function closeColours(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
}

const colourOf = async (request: Parameters<typeof apiData>[0], id: string) =>
  (await apiData<Task>(request, `/tasks/${id}`)).color

test('a preset or a typed hex marks the row, header, grid frame and reply box, persists, and None clears', async ({
  page,
  request,
}) => {
  const title = unique('Painted agent')
  const id = await seedAgent(title)
  await page.goto(`/#agents/${id}`)
  const main = page.getByRole('main')
  const row = page.locator(`[data-task-id="${id}"] button`)
  const header = main.locator('.agent-tint').filter({ has: page.getByRole('heading', { name: title }) })

  let dialog = await openColours(page)
  const swatches = dialog.getByRole('group', { name: 'Color' })
  await expect(swatches.getByRole('button')).toHaveCount(15)
  await expect(swatches.getByRole('button', { name: 'None' })).toHaveAttribute('aria-pressed', 'true')
  await swatches.getByRole('button', { name: 'Teal', exact: true }).click()
  await expect(swatches.getByRole('button', { name: 'Teal', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(async () => colourOf(request, id)).toBe('#3baca6')
  await expect(dialog.getByRole('button', { name: 'Colour Teal' })).toHaveAttribute('aria-expanded', 'true')
  await expect(dialog.getByRole('textbox', { name: 'Hex colour' })).toHaveValue('#3baca6')
  await closeColours(page)
  await expect(row).toHaveAttribute('data-agent-color', '#3baca6')
  const teal = await inkOf(row)
  expect(await stripeOf(row)).toContain(teal.stripe)
  await expect(row).toHaveCSS('background-color', teal.tint)
  await expect(header).toHaveCSS('background-color', teal.tint)

  dialog = await openColours(page)
  const hex = dialog.getByRole('textbox', { name: 'Hex colour' })
  await hex.fill('#38g')
  await expect(hex).toHaveAttribute('aria-invalid', 'true')
  await hex.fill('#38F')
  const preview = dialog.getByTestId('agent-color-preview')
  await expect(preview).toHaveAttribute('data-agent-color', '#3388ff')
  await hex.press('Enter')
  await expect.poll(async () => colourOf(request, id)).toBe('#3388ff')
  await expect(dialog.getByRole('group', { name: 'Color' }).getByRole('button', { pressed: true })).toHaveCount(0)
  const previewInk = await inkOf(preview)
  await closeColours(page)

  const check = async () => {
    await expect(row).toHaveAttribute('data-agent-color', '#3388ff')
    const ink = await inkOf(row)
    expect(ink).toEqual(previewInk)
    expect(ink.stripe).not.toBe(teal.stripe)
    expect(await stripeOf(row)).toContain(ink.stripe)
    await expect(header).toHaveCSS('background-color', ink.tint)
    await expect(header.locator('.agent-rule').first()).toHaveCSS('border-bottom-color', ink.stripe)
    const reply = main.getByRole('combobox', { name: 'Reply' })
    await reply.focus()
    await expect(reply).toHaveCSS('caret-color', ink.stripe)
    await expect(reply).toHaveCSS('border-top-color', ink.stripe)
    return ink
  }
  const light = await check()
  await page.reload()
  await check()

  await page.emulateMedia({ colorScheme: 'dark' })
  await expect.poll(async () => (await inkOf(row)).stripe).not.toBe(light.stripe)
  await page.emulateMedia({ colorScheme: 'light' })
  await expect.poll(async () => (await inkOf(row)).stripe).toBe(light.stripe)

  await page.keyboard.press('Control+k')
  await page.getByRole('combobox').fill('#3388ff')
  await expect(page.getByRole('option', { name: new RegExp(title) })).toHaveAttribute('data-agent-color', '#3388ff')
  await page.keyboard.press('Escape')

  await main.getByRole('button', { name: 'Open in grid' }).click()
  const panel = page.locator('[data-grid-panel]').filter({ has: page.getByRole('heading', { name: title }) })
  await expect(panel).toHaveAttribute('data-agent-color', '#3388ff')
  expect(await frameOf(panel)).toBe(light.stripe)
  await expect(panel.locator('.agent-tint').first()).toHaveCSS('background-color', light.tint)
  await page.getByRole('button', { name: 'Grid', exact: true }).click()

  dialog = await openColours(page)
  await dialog.getByRole('group', { name: 'Color' }).getByRole('button', { name: 'None' }).click()
  await expect.poll(async () => colourOf(request, id)).toBeNull()
  await closeColours(page)
  await expect(row).not.toHaveAttribute('data-agent-color')
  expect(await stripeOf(row)).toBe('none')
  await expect(header).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
})
