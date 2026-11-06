import fs from 'node:fs'
import path from 'node:path'
import { CODE, downloadUrl, OTHER_LINK, seedMentions } from './support/file-mentions.js'
import { expect, test, unique } from './support/fixtures.js'

test('files in agent replies show as chips and cards that open Files, and other links stay links', async ({ page }) => {
  const { id } = await seedMentions(unique('Mentions'))
  await page.goto(`/#agents/${id}`)
  const transcript = page.getByRole('region', { name: 'Transcript' })

  const chip = transcript.getByRole('button', { name: 'Open notes/plan.md in Files' })
  await expect(chip).toBeVisible()
  await expect(chip).toHaveAttribute('data-file-mention', '')
  await expect(chip).toHaveText('notes/plan.md')
  await expect(transcript.getByText('out/missing.pdf')).toBeVisible()
  await expect(transcript.locator('[data-file-link="out/missing.pdf"]')).toHaveCount(0)

  const card = transcript.locator('[data-file-card][data-file-link="src/greet.ts"]')
  await expect(card).toBeVisible()
  await expect(card).toHaveAccessibleName('Open src/greet.ts in Files')
  await expect(card).toContainText('greet.ts')
  await expect(card).toContainText(`${String(Buffer.byteLength(CODE))} B, changed`)
  await expect(card.locator('[data-file-head]')).toHaveText(/^export function greet\(name: string\) \{/)
  await expect(transcript.getByText('seti.example.com')).toHaveCount(0)

  const other = transcript.getByRole('link', { name: OTHER_LINK })
  await expect(other).toHaveAttribute('href', OTHER_LINK)
  await expect(other).toHaveAttribute('target', '_blank')
  await expect(other).not.toHaveAttribute('data-file-link')

  await chip.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('region', { name: 'File notes/plan.md' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Launch plan' })).toBeVisible()

  await card.click()
  await expect(page.getByRole('region', { name: 'File src/greet.ts' })).toBeVisible()
})

test('a file mentioned before it exists becomes a chip once the agent writes it', async ({ page }) => {
  const { id, dir } = await seedMentions(unique('Later file'))
  await page.clock.install()
  await page.goto(`/#agents/${id}`)
  const transcript = page.getByRole('region', { name: 'Transcript' })
  await expect(transcript.getByText('out/missing.pdf')).toBeVisible()
  await expect(transcript.locator('[data-file-link="out/missing.pdf"]')).toHaveCount(0)

  fs.mkdirSync(path.join(dir, 'out'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'out', 'missing.pdf'), '%PDF-1.4\n')
  await page.clock.fastForward(25_000)
  await expect(transcript.locator('[data-file-mention][data-file-link="out/missing.pdf"]')).toBeVisible()
})

test.describe("the user's own messages", () => {
  test.use({ allowedHttpStatuses: [409] })

  test('show files in sent, queued, sending and failed messages as chips and cards', async ({ page }) => {
    const { id } = await seedMentions(unique('Own mentions'))
    let held = false
    await page.route(`**/api/tasks/${id}/messages`, async (route) => {
      if (route.request().method() !== 'POST') {
        await route.fallback()
        return
      }
      if (held) {
        return
      }
      held = true
      await route.fulfill({ status: 409, json: { error: { detail: 'The agent cannot take messages now' } } })
    })
    await page.goto(`/#agents/${id}`)
    const transcript = page.getByRole('region', { name: 'Transcript' })

    const sent = transcript.locator('[data-own-message]').filter({ hasText: 'Start from' })
    await expect(sent.locator('[data-file-mention][data-file-link="notes/brief.txt"]')).toHaveText('notes/brief.txt')
    const card = sent.locator('[data-file-card][data-file-link="src/farewell.ts"]')
    await expect(card.locator('[data-file-head]')).toHaveText(/^export function farewell/)
    await expect(sent).not.toContainText('seti.example.com')
    const queued = transcript.locator('[data-own-message]').filter({ hasText: 'Then tidy' })
    await expect(queued.locator('[data-file-mention][data-file-link="notes/todo.md"]')).toBeVisible()

    const reply = page.getByRole('combobox', { name: 'Reply' })
    await reply.fill(`Compare notes/plan.md with\n${downloadUrl(id, 'src/greet.ts')}`)
    await reply.press('Enter')
    const failed = page.locator('[data-pending-send][data-state="failed"]')
    await expect(failed.locator('[data-file-mention][data-file-link="notes/plan.md"]')).toBeVisible()
    await expect(failed.locator('[data-file-card][data-file-link="src/greet.ts"]')).toBeVisible()

    await reply.fill('And notes/todo.md too')
    await reply.press('Enter')
    const sending = page.locator('[data-pending-send][data-state="sending"]')
    await expect(sending.locator('[data-file-mention][data-file-link="notes/todo.md"]')).toBeVisible()

    await card.click()
    await expect(page.getByRole('region', { name: 'File src/farewell.ts' })).toBeVisible()
  })
})
