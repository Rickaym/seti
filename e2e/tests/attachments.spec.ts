import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Locator, Page } from '@playwright/test'
import type { CommandCatalog, Envelope, MessagePage, PromptPayload } from '@seti/shared'
import { openSeedDb } from './support/db.js'
import { paths } from './support/env.js'
import { apiData, expect, test } from './support/fixtures.js'

const BIG_JSON = JSON.stringify(
  Array.from({ length: 60 }, (_, n) => ({ id: n, name: `user-${String(n)}` })),
  null,
  2,
)
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n', 'latin1')
/** A 1x1 transparent PNG, small enough for the model to see. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

const CATALOG: CommandCatalog = {
  cwd: paths.checkout,
  probed_at: new Date().toISOString(),
  fresh: true,
  approximate: false,
  commands: [],
}

async function seedTask(): Promise<string> {
  const db = openSeedDb()
  const id = randomUUID()
  const at = new Date().toISOString()
  await db.idleTask(id, 'Attachments', paths.checkout, at)
  await db.message(id, 'prompt', JSON.stringify({ text: 'Seeded prompt for attachments.' }), at)
  await db.close()
  return id
}

async function openTask(page: Page, taskId: string): Promise<Locator> {
  await page.route(/\/api\/tasks\/[^/]+\/commands$/, async (route) =>
    route.fulfill({ json: { data: CATALOG, meta: {} } satisfies Envelope<CommandCatalog> }),
  )
  await page.goto(`/#agents/${taskId}`)
  await expect(page.getByText('Seeded prompt for attachments.')).toBeVisible()
  return page.getByRole('combobox', { name: 'Reply' })
}

/** Puts text or a PNG on the system clipboard and pastes it with the keyboard, as a person would. */
async function paste(field: Locator, content: { text: string } | { png: Buffer }) {
  await field.page().context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await field.focus()
  await field.evaluate(
    async (_el, item) => {
      if ('text' in item) {
        await navigator.clipboard.writeText(item.text)
        return
      }
      const bytes = Uint8Array.from(atob(item.png), (c) => c.charCodeAt(0))
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })])
    },
    'text' in content ? content : { png: content.png.toString('base64') },
  )
  await field.press('ControlOrMeta+v')
}

async function drop(field: Locator, name: string, bytes: Buffer) {
  const transfer = await field.page().evaluateHandle(
    ({ fileName, mime, base64 }) => {
      const data = new DataTransfer()
      const raw = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
      data.items.add(new File([raw], fileName, { type: mime }))
      return data
    },
    { fileName: name, mime: 'application/pdf', base64: bytes.toString('base64') },
  )
  await field.dispatchEvent('dragover', { dataTransfer: transfer })
  await field.dispatchEvent('drop', { dataTransfer: transfer })
}

const chips = (page: Page) => page.getByRole('list', { name: 'Attachments' })

async function prompts(page: Page, taskId: string): Promise<PromptPayload[]> {
  const result = await apiData<MessagePage>(page.request, `/tasks/${taskId}/messages?limit=50`)
  return result.messages.flatMap((row) => (row.kind === 'prompt' ? [row.payload] : []))
}

const uploads = (taskId: string) => path.join(paths.setiHome, 'workspace', taskId, 'uploads')

test.describe('composer attachments', () => {
  test('a big JSON paste goes to the agent as a file in its workspace, a small one stays inline', async ({ page }) => {
    const taskId = await seedTask()
    const reply = await openTask(page, taskId)

    await paste(reply, { text: 'just a short note' })
    await expect(reply).toHaveValue('just a short note')
    await expect(chips(page)).toHaveCount(0)

    await reply.fill('Check this: ')
    await reply.press('End')
    await paste(reply, { text: BIG_JSON })
    const chip = chips(page).getByRole('listitem', { name: 'paste-1.json' })
    await expect(chip).toContainText(/JSON, 242 lines, \d\.\d KB/)
    await expect(reply).toHaveValue('Check this: [paste-1.json] ')

    await reply.press('Enter')
    await expect(chips(page)).toHaveCount(0)
    await expect(reply).toHaveValue('')

    await expect.poll(async () => (await prompts(page, taskId)).length).toBe(2)
    const sent = (await prompts(page, taskId))[1]
    const file = sent?.attachments?.[0]
    expect(path.dirname(file?.path ?? '')).toBe(uploads(taskId))
    expect(path.basename(file?.path ?? '')).toMatch(/^\d{8}-\d{6}-1\.json$/)
    expect(sent?.text).toBe(`Check this: Pasted as ${file?.path ?? ''} (JSON, 242 lines, 2.6 KB)`)
    expect(fs.readFileSync(file?.path ?? '', 'utf8')).toBe(BIG_JSON)

    const transcript = page.getByRole('region', { name: 'Transcript' })
    const sentChip = transcript.locator(`[data-file-link="uploads/${path.basename(file?.path ?? '')}"]`)
    await expect(sentChip).toContainText('JSON, 242 lines')
    await expect(transcript.getByText('"name": "user-1"')).toHaveCount(0)
    await sentChip.click()
    await expect(page.getByRole('region', { name: 'Files', exact: true })).toContainText('user-59')
  })

  test('a paste can be dropped or put back inline, and survives a reload', async ({ page }) => {
    const taskId = await seedTask()
    const reply = await openTask(page, taskId)

    await paste(reply, { text: BIG_JSON })
    await expect(chips(page)).toContainText('JSON, 242 lines')
    await page.getByRole('button', { name: 'Drop paste-1.json' }).click()
    await expect(chips(page)).toHaveCount(0)
    await expect(reply).toHaveValue('')

    await reply.fill('Before ')
    await reply.press('End')
    await paste(reply, { text: BIG_JSON })
    await expect(chips(page)).toContainText('JSON, 242 lines')
    const saved = async () =>
      page.evaluate(
        (key) => [localStorage.getItem(`seti.draft.${key}`), localStorage.getItem(`seti.draft-files.${key}`)],
        `task.${taskId}`,
      )
    await expect.poll(async () => (await saved()).every((value) => value?.includes('paste-1.json') === true)).toBe(true)
    await page.reload()
    await expect(reply).toHaveValue('Before [paste-1.json] ')
    await expect(chips(page)).toContainText('paste-1.json')

    await page.getByRole('button', { name: 'Inline paste-1.json' }).click()
    await expect(chips(page)).toHaveCount(0)
    await expect(reply).toHaveValue(`Before ${BIG_JSON} `)
  })

  test('a pasted image, a dropped PDF and a picked file go along, the image as a thumbnail', async ({ page }) => {
    const taskId = await seedTask()
    const reply = await openTask(page, taskId)

    await paste(reply, { png: PNG })
    const image = chips(page).getByRole('listitem', { name: 'image.png' })
    await expect(image).toContainText('PNG image')
    await expect(image.getByRole('img', { name: 'image.png' })).toBeVisible()

    await drop(reply, 'report.pdf', PDF)
    await expect(chips(page).getByRole('listitem', { name: 'report.pdf' })).toContainText(/PDF, \d+ B/)

    await page.getByLabel('Attach files').setInputFiles({
      name: 'notes.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('# Notes\n\n- one\n- two\n'),
    })
    await expect(chips(page).getByRole('listitem', { name: 'notes.md' })).toContainText('Markdown')
    await expect(reply).toHaveValue('[image.png] [report.pdf] [notes.md]')

    await reply.press('Home')
    await reply.pressSequentially('Look at these: ')
    await reply.press('Enter')
    await expect.poll(async () => (await prompts(page, taskId)).length).toBe(2)
    const sent = (await prompts(page, taskId))[1]
    expect(sent?.attachments?.map((file) => file.name)).toEqual(['image.png', 'report.pdf', 'notes.md'])
    expect(sent?.attachments?.[0]?.shown).toBe(true)
    expect(fs.readFileSync(path.join(uploads(taskId), 'report.pdf'))).toEqual(PDF)
    expect(sent?.text).toContain(`Attached ${path.join(uploads(taskId), 'report.pdf')} (PDF, `)

    const transcript = page.getByRole('region', { name: 'Transcript' })
    await expect(transcript.locator('[data-file-link="uploads/image.png"]').getByRole('img')).toBeVisible()
  })
})

test('the start page sends a big paste as a file of the new agent', async ({ page }) => {
  await page.goto('/#agents')
  const message = page.getByLabel('Message')
  await message.fill('planner down: summarise ')
  await message.press('End')
  await paste(message, { text: BIG_JSON })
  await expect(chips(page)).toContainText('JSON, 242 lines')
  await message.press('Enter')
  await expect(page).toHaveURL(/#agents\/[\da-f-]{36}$/)
  const taskId = new URL(page.url()).hash.split('/')[1] ?? ''
  await expect.poll(async () => (await prompts(page, taskId)).length).toBe(1)
  const [first] = await prompts(page, taskId)
  const file = first?.attachments?.[0]
  expect(first?.text).toBe(`planner down: summarise Pasted as ${file?.path ?? ''} (JSON, 242 lines, 2.6 KB)`)
  expect(fs.readFileSync(file?.path ?? '', 'utf8')).toBe(BIG_JSON)
  await expect(page.getByRole('region', { name: 'Transcript' })).toContainText('paste')
  await page.goto('/#agents')
  expect((await page.request.delete(`/api/tasks/${taskId}`)).ok()).toBe(true)
})
