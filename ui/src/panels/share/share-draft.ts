import { attachmentStore, tokenFor, uniqueName, type DraftAttachment } from '@/lib/attachments'
import { drafts, NEW_TASK_PROMPT } from '@/lib/drafts'
import type { ShareManifest } from '@/lib/share-inbox'

/** The shared title, text and link as one message, leaving out what the text already holds. */
export function sharedText({ title, text, url }: Pick<ShareManifest, 'title' | 'text' | 'url'>): string {
  const link = url !== '' && !text.includes(url) ? url : ''
  const heading = title !== '' && title !== url && !text.includes(title) ? title : ''
  return [heading, text, link].filter((part) => part !== '').join('\n')
}

interface Draft {
  text: string
  items: DraftAttachment[]
}

/** The start page's draft with the share after it; shared files it already has get new names. */
export function joinDrafts(start: Draft, shared: Draft): Draft {
  const taken = start.items.map((item) => item.name)
  let text = shared.text
  const items = shared.items.map((item) => {
    const name = uniqueName(item.name, taken)
    taken.push(name)
    if (name === item.name) {
      return item
    }
    const token = tokenFor(name)
    text = text.replaceAll(item.token, token)
    return { ...item, name, token }
  })
  const joined = [start.text.trimEnd(), text.trim()].filter((part) => part !== '').join('\n\n')
  return { text: joined, items: [...start.items, ...items] }
}

/** Hands the share to the start page's draft, where New agent picks it up. */
export function carryToStart(shared: Draft): void {
  const start = { text: drafts.read(NEW_TASK_PROMPT), items: attachmentStore.read(NEW_TASK_PROMPT) }
  const joined = joinDrafts(start, shared)
  drafts.write(NEW_TASK_PROMPT, joined.text)
  attachmentStore.write(NEW_TASK_PROMPT, joined.items)
}
