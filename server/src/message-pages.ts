import type { MessageRow } from '@seti/shared'
import { messages } from './db.js'

const PAGE_ROWS = 1000

/** Visits the rows after `afterId` a page at a time, so a long transcript never loads whole. */
export async function eachMessageAfter(
  taskId: string,
  afterId: number,
  visit: (row: MessageRow) => void,
): Promise<void> {
  let last = afterId
  for (;;) {
    const page = await messages.firstAfter(taskId, last, PAGE_ROWS)
    page.forEach(visit)
    const tail = page.at(-1)
    if (tail === undefined || page.length < PAGE_ROWS) {
      return
    }
    last = tail.id
  }
}
