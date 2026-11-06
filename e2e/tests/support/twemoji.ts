import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { openSeedDb } from './db.js'
import { paths } from './env.js'
import { expect } from './fixtures.js'
import { modToggle } from './mods.js'

const ROCKET = '\u{1F680}'
const PARTY = '\u{1F389}'
const THUMBS_UP = '\u{1F44D}'

const REPLY_TEXT = `All done ${THUMBS_UP}`
const DRAFT = `Thanks ${PARTY}`
const NOTE = `# Launch ${ROCKET}\n\nShipped on time.\n`

const assistant = (content: unknown[]) => ({
  type: 'assistant',
  message: { id: randomUUID(), type: 'message', role: 'assistant', model: 'claude', content },
  parent_tool_use_id: null,
  session_id: 'emoji-session',
  uuid: randomUUID(),
})

/** An idle agent that wrote a Markdown note and replied, each with an emoji. */
export async function seedEmojiAgent(): Promise<string> {
  const id = randomUUID()
  const dir = path.join(paths.root, `emoji-${id.slice(0, 8)}`)
  fs.mkdirSync(path.join(dir, 'notes'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'notes', 'launch.md'), NOTE)
  const at = new Date(Date.now() - 60_000).toISOString()
  const write = {
    type: 'tool_use',
    id: 'toolu_write_launch',
    name: 'Write',
    input: { file_path: path.join(dir, 'notes', 'launch.md'), content: NOTE },
  }
  const db = openSeedDb()
  await db.idleTask(id, 'Launch note', dir, at)
  await db.message(id, 'prompt', JSON.stringify({ text: 'Write the launch note.' }), at)
  await db.message(id, 'sdk', JSON.stringify(assistant([write])), at)
  await db.message(id, 'sdk', JSON.stringify(assistant([{ type: 'text', text: REPLY_TEXT }])), at)
  await db.close()
  return id
}

interface CdpNode {
  nodeId: number
  attributes?: string[]
  children?: CdpNode[]
  shadowRoots?: CdpNode[]
}

const subtree = (node: CdpNode): CdpNode[] => [
  node,
  ...[...(node.children ?? []), ...(node.shadowRoots ?? [])].flatMap(subtree),
]

/** The fonts Chromium drew an element's text with, a field's shadow text included. */
async function drawnFonts(page: Page, target: Locator): Promise<string[]> {
  const marker = randomUUID()
  await target.evaluate((el, value) => {
    el.setAttribute('data-font-probe', value)
  }, marker)
  const cdp = await page.context().newCDPSession(page)
  try {
    await cdp.send('DOM.enable')
    await cdp.send('CSS.enable')
    const { root } = (await cdp.send('DOM.getDocument', { depth: -1, pierce: true })) as { root: CdpNode }
    const probe = subtree(root).find((node) => {
      const attributes = node.attributes ?? []
      const at = attributes.indexOf('data-font-probe')
      return at !== -1 && attributes[at + 1] === marker
    })
    const families = new Set<string>()
    for (const node of probe === undefined ? [] : subtree(probe)) {
      const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId: node.nodeId })
      for (const font of fonts) {
        families.add(font.familyName)
      }
    }
    return [...families]
  } finally {
    await cdp.detach()
  }
}

/** Which font drew the emoji: Twemoji, a platform font beside the text font, or none. */
async function emojiFont(page: Page, target: Locator): Promise<string> {
  const families = await drawnFonts(page, target)
  if (families.some((family) => family.startsWith('Twemoji'))) {
    return 'Twemoji'
  }
  return families.length > 1 ? 'native' : 'none'
}

async function expectFont(page: Page, name: string, target: Locator, on: boolean): Promise<void> {
  await expect
    .poll(async () => emojiFont(page, target), { message: `the font of the emoji in the ${name}` })
    .toBe(on ? 'Twemoji' : 'native')
}

/** Checks the transcript reply, the composer and the Markdown note, then closes the note. */
export async function expectTwemoji(page: Page, on: boolean): Promise<void> {
  await expect(page.locator('style[data-mod-style="twemoji.emoji"]')).toHaveCount(on ? 1 : 0)
  const transcript = page.getByRole('region', { name: 'Transcript' })
  await expectFont(page, 'transcript', transcript.getByText(REPLY_TEXT), on)
  const reply = page.getByRole('combobox', { name: 'Reply' })
  await reply.fill(DRAFT)
  await expectFont(page, 'composer', reply, on)
  await transcript.getByRole('button', { name: 'Open notes/launch.md in Files' }).click()
  const files = page.getByRole('region', { name: 'Files', exact: true })
  await expectFont(page, 'Markdown note', files.getByRole('heading', { name: /^Launch/ }), on)
  await files.getByRole('button', { name: 'Close Files' }).click()
  await expect(files).toHaveCount(0)
}

/** Flips the Twemoji switch on Settings, Mods and returns to the agent, all without a reload. */
export async function switchTwemoji(page: Page, agentId: string, on: boolean): Promise<void> {
  await page.goto('/#settings/mods')
  const toggle = modToggle(page, 'Twemoji')
  await toggle.scrollIntoViewIfNeeded()
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', String(on))
  await page.goto(`/#agents/${agentId}`)
}

/** Marks the loaded page, so a test can tell it was never reloaded. */
export async function markPage(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.documentElement.dataset.twemojiProbe = 'loaded'
  })
}

export const samePage = async (page: Page) =>
  page.evaluate(() => document.documentElement.dataset.twemojiProbe === 'loaded')
