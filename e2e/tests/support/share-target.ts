import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import type { AuditPage, MessagePage, PromptPayload } from '@seti/shared'
import { openSeedDb } from './db.js'
import { paths } from './env.js'
import { apiData, expect } from './fixtures.js'

export interface SharedFile {
  name: string
  type: string
  body: string | Buffer
}

export interface ShareSheet {
  title?: string
  text?: string
  url?: string
  files?: SharedFile[]
}

/** Opens Seti and waits until its service worker controls the page, as an installed app is. */
export async function underServiceWorker(page: Page): Promise<void> {
  await page.goto('/')
  await expect
    .poll(async () => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? null))
    .not.toBe(null)
}

/** Posts to the share target as the share sheet does: a multipart form navigation. */
export async function shareToSeti(page: Page, share: ShareSheet): Promise<void> {
  const encoded = (share.files ?? []).map((file) => ({ ...file, body: Buffer.from(file.body).toString('base64') }))
  await page.evaluate(
    (sheet) => {
      const form = document.createElement('form')
      form.method = 'post'
      form.enctype = 'multipart/form-data'
      form.action = '/share-target'
      for (const name of ['title', 'text', 'url'] as const) {
        const input = document.createElement('input')
        input.type = 'hidden'
        input.name = name
        input.value = sheet[name] ?? ''
        form.append(input)
      }
      const files = document.createElement('input')
      files.type = 'file'
      files.name = 'files'
      files.multiple = true
      const picked = new DataTransfer()
      for (const file of sheet.files) {
        const bytes = Uint8Array.from(atob(file.body), (char) => char.charCodeAt(0))
        picked.items.add(new File([bytes], file.name, { type: file.type }))
      }
      files.files = picked.files
      form.append(files)
      document.body.append(form)
      form.submit()
    },
    { ...share, files: encoded },
  )
  await page.waitForURL(/#share$/)
}

/** Whether the share still waits in this browser's inbox. */
export const shareWaits = async (page: Page) => page.evaluate(async () => caches.has('seti-share-inbox'))

/** Seeds an idle agent with one earlier prompt, and returns its id. */
export async function seedAgent(title: string): Promise<string> {
  const db = openSeedDb()
  const id = randomUUID()
  const at = new Date().toISOString()
  await db.idleTask(id, title, paths.checkout, at)
  await db.message(id, 'prompt', JSON.stringify({ text: `Seeded prompt of ${title}.` }), at)
  await db.close()
  return id
}

/** The prompts the agent holds, oldest first. */
export async function prompts(page: Page, taskId: string): Promise<PromptPayload[]> {
  const rows = await apiData<MessagePage>(page.request, `/tasks/${taskId}/messages?limit=50`)
  return rows.messages.flatMap((row) => (row.kind === 'prompt' ? [row.payload] : []))
}

/** The audit detail of the last message sent to the agent. */
export async function lastSendAudit(page: Page, taskId: string): Promise<Record<string, unknown> | undefined> {
  const audit = await apiData<AuditPage>(page.request, '/audit?kind=task.message_sent&limit=50')
  return audit.events.find((event) => event.subject_id === taskId)?.detail
}
