import { randomUUID } from 'node:crypto'
import type { CDPSession, Page } from '@playwright/test'
import type { SendMessageInput } from '@seti/shared'
import { openSeedDb } from './support/db.js'
import { paths } from './support/env.js'
import { expect, test } from './support/fixtures.js'

async function seedTask(): Promise<string> {
  const db = openSeedDb()
  const id = randomUUID()
  const at = new Date().toISOString()
  await db.idleTask(id, 'Phone typing', paths.checkout, at)
  await db.message(id, 'prompt', JSON.stringify({ text: 'Seeded typing prompt.' }), at)
  await db.close()
  return id
}

/** Records each change page scripts make to a textarea while an IME composition is open. */
function watchCompositionWrites(): void {
  const writes: string[] = []
  let composing = false
  Reflect.set(window, '__compositionWrites', writes)
  document.addEventListener('compositionstart', () => (composing = true), true)
  document.addEventListener('compositionend', () => (composing = false), true)
  const note = (what: string) => {
    if (composing) {
      writes.push(what)
    }
  }
  const proto = HTMLTextAreaElement.prototype
  for (const name of ['value', 'defaultValue'] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, name)
    const get = Reflect.get(descriptor ?? {}, 'get') as ((this: HTMLTextAreaElement) => string) | undefined
    const set = Reflect.get(descriptor ?? {}, 'set') as ((this: HTMLTextAreaElement, text: string) => void) | undefined
    if (descriptor !== undefined && get !== undefined && set !== undefined) {
      Object.defineProperty(proto, name, {
        ...descriptor,
        set(this: HTMLTextAreaElement, text: string) {
          if (get.call(this) !== text) {
            note(`${name} = ${JSON.stringify(text)}`)
          }
          set.call(this, text)
        },
      })
    }
  }
  for (const name of ['setSelectionRange', 'setRangeText', 'select'] as const) {
    const original = Reflect.get(proto, name) as (...args: unknown[]) => unknown
    Object.defineProperty(proto, name, {
      value(this: HTMLTextAreaElement, ...args: unknown[]) {
        note(`${name}(${JSON.stringify(args)})`)
        return original.apply(this, args)
      },
    })
  }
  new MutationObserver((records) => {
    for (const record of records) {
      if (record.target instanceof HTMLTextAreaElement || record.target.parentNode instanceof HTMLTextAreaElement) {
        note(`${record.type} mutation`)
      }
    }
  }).observe(document, { childList: true, characterData: true, subtree: true })
}

const compositionWrites = async (page: Page) =>
  page.evaluate(() => Reflect.get(window, '__compositionWrites') as string[])

/** Types a word as Gboard does: a composition growing letter by letter, then `commit` and a space. */
async function typeWord(cdp: CDPSession, typed: string, commit = typed, between?: () => Promise<void>) {
  for (let i = 1; i <= typed.length; i++) {
    await cdp.send('Input.imeSetComposition', { text: typed.slice(0, i), selectionStart: i, selectionEnd: i })
    if (i === Math.ceil(typed.length / 2)) {
      await between?.()
    }
  }
  await cdp.send('Input.insertText', { text: commit })
  await cdp.send('Input.insertText', { text: ' ' })
}

async function openReply(page: Page, id: string) {
  await page.addInitScript(watchCompositionWrites)
  await page.goto(`/#agents/${id}`)
  await expect(page.getByText('Seeded typing prompt.')).toBeVisible()
  const reply = page.getByRole('combobox', { name: 'Reply' })
  await reply.tap()
  return { reply, cdp: await page.context().newCDPSession(page) }
}

test('composing words with autocorrect leaves the reply box to the keyboard', async ({ page }) => {
  const id = await seedTask()
  const { reply, cdp } = await openReply(page, id)

  await typeWord(cdp, 'the')
  await typeWord(cdp, 'weather')
  await typeWord(cdp, 'travker', 'tracker')
  await typeWord(cdp, 'then')

  await expect(reply).toHaveValue('the weather tracker then ')
  expect(await compositionWrites(page)).toEqual([])
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
  await expect
    .poll(async () => page.evaluate((key) => localStorage.getItem(key), `seti.draft.task.${id}`))
    .toBe('the weather tracker then ')
})

test('a send that lands mid-word keeps the word and drops only the sent text', async ({ page }) => {
  const id = await seedTask()
  const sent: SendMessageInput[] = []
  let release: () => void = () => undefined
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route(`**/api/tasks/${id}/messages`, async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fallback()
      return
    }
    sent.push(route.request().postDataJSON() as SendMessageInput)
    await released
    await route.fulfill({ json: { data: {}, meta: {} } })
  })
  const { reply, cdp } = await openReply(page, id)

  await typeWord(cdp, 'first')
  await typeWord(cdp, 'message')
  const posted = page.waitForResponse(`**/api/tasks/${id}/messages`)
  await page.getByRole('button', { name: 'Send', exact: true }).tap()
  await expect.poll(() => sent.length).toBe(1)
  await reply.tap()
  await reply.evaluate((field: HTMLTextAreaElement) => {
    field.setSelectionRange(field.value.length, field.value.length)
  })
  await typeWord(cdp, 'the')
  await typeWord(cdp, 'travker', 'tracker', async () => {
    release()
    await posted
    await page.evaluate(async () => new Promise((resolve) => requestAnimationFrame(resolve)))
  })

  expect(sent[0]?.prompt).toBe('first message ')
  await expect(reply).toHaveValue('the tracker ')
  expect(await compositionWrites(page)).toEqual([])
})
