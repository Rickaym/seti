import { randomUUID } from 'node:crypto'
import type { Locator, Page } from '@playwright/test'
import { openSeedDb } from './db.js'
import { paths } from './env.js'
import { expect } from './fixtures.js'

/** The upload request, whose query carries the file's name. */
export const UPLOAD_URL = /\/api\/uploads\?/

/** Longer than the time without bytes after which the composer calls an upload stalled. */
export const PAST_STALL_MS = 31_000

const PDF_HEAD = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n', 'latin1')

/** A PDF of `bytes` bytes: a real header, then padding. */
export const pdfOf = (bytes: number) => Buffer.concat([PDF_HEAD, Buffer.alloc(bytes - PDF_HEAD.length, 0x20)])

/** An idle agent with one prompt, opened at its reply box. */
export async function openAgent(page: Page, title: string): Promise<string> {
  const db = openSeedDb()
  const id = randomUUID()
  const at = new Date().toISOString()
  const prompt = `Seeded prompt for ${title}.`
  await db.idleTask(id, title, paths.checkout, at)
  await db.message(id, 'prompt', JSON.stringify({ text: prompt }), at)
  await db.close()
  await page.goto(`/#agents/${id}`)
  await expect(page.getByText(prompt)).toBeVisible()
  return id
}

export async function attach(page: Page, name: string, buffer: Buffer): Promise<Locator> {
  await page.getByLabel('Attach files').setInputFiles({ name, mimeType: 'application/octet-stream', buffer })
  return page.getByRole('list', { name: 'Attachments' }).getByRole('listitem', { name })
}

export const composerStatus = (page: Page) => page.getByRole('status', { name: 'Composer status' })

interface HeldUploads {
  count: () => number
  stopped: () => number
  progress: (n: number, fraction: number) => void
  release: (n: number) => void
}

const HELD = 'setiHeldUploads'

/** Runs in the page: keeps each upload from leaving, so a test moves its bytes by hand. */
function holdInPage(key: string): void {
  const held: { xhr: XMLHttpRequest; body: Blob }[] = []
  const uploads = new WeakSet<XMLHttpRequest>()
  const native = (name: string): unknown => Reflect.get(XMLHttpRequest.prototype, name)
  const open = native('open') as (this: XMLHttpRequest, ...args: unknown[]) => void
  const send = native('send') as (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) => void
  const abort = native('abort') as (this: XMLHttpRequest) => void
  let stopped = 0
  XMLHttpRequest.prototype.open = function openHeld(this: XMLHttpRequest, ...args: unknown[]) {
    if (String(args[1]).includes('/api/uploads?')) {
      uploads.add(this)
    }
    open.apply(this, args)
  }
  XMLHttpRequest.prototype.send = function sendHeld(this: XMLHttpRequest, body) {
    if (uploads.has(this) && body instanceof Blob) {
      held.push({ xhr: this, body })
      return
    }
    send.call(this, body)
  }
  XMLHttpRequest.prototype.abort = function abortHeld(this: XMLHttpRequest) {
    stopped += uploads.has(this) ? 1 : 0
    abort.call(this)
  }
  const controls: HeldUploads = {
    count: () => held.length,
    stopped: () => stopped,
    progress: (n, fraction) => {
      const upload = held[n]
      const total = upload?.body.size ?? 0
      const loaded = Math.round(total * fraction)
      upload?.xhr.upload.dispatchEvent(new ProgressEvent('progress', { lengthComputable: true, loaded, total }))
    },
    release: (n) => {
      const upload = held[n]
      if (upload !== undefined) {
        send.call(upload.xhr, upload.body)
      }
    },
  }
  Reflect.set(window, key, controls)
}

/** Holds every upload of the page before it leaves; call before the page loads. */
export const holdUploads = async (page: Page) => page.addInitScript(holdInPage, HELD)

async function whenHeld(page: Page, n: number): Promise<void> {
  await expect
    .poll(async () => page.evaluate((key) => (Reflect.get(window, key) as HeldUploads).count(), HELD))
    .toBeGreaterThan(n)
}

/** How many uploads the page stopped itself. */
export const stopped = async (page: Page) =>
  page.evaluate((key) => (Reflect.get(window, key) as HeldUploads).stopped(), HELD)

/** Reports the nth held upload as `fraction` of its bytes sent. */
export async function reportProgress(page: Page, n: number, fraction: number): Promise<void> {
  await whenHeld(page, n)
  await page.evaluate(
    ([key, index, part]) => {
      ;(Reflect.get(window, key) as HeldUploads).progress(index, part)
    },
    [HELD, n, fraction] as const,
  )
}

/** Lets the nth held upload go to the server. */
export async function release(page: Page, n: number): Promise<void> {
  await whenHeld(page, n)
  await page.evaluate(
    ([key, index]) => {
      ;(Reflect.get(window, key) as HeldUploads).release(index)
    },
    [HELD, n] as const,
  )
}
