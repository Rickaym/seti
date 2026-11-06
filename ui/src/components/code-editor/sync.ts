import { Annotation, type ChangeSpec, type Transaction } from '@codemirror/state'

/** Marks a transaction that brings the editor in line with its `value` prop. */
export const fromValue = Annotation.define<boolean>()

/** Where the cursor sat in the stand-in textarea, so the editor can take over the same spot. */
export interface Caret {
  anchor: number
  head: number
}

/** The smallest change that turns `from` into `to`, or null when they already match. */
export function changeBetween(from: string, to: string): ChangeSpec | null {
  if (from === to) {
    return null
  }
  const limit = Math.min(from.length, to.length)
  let start = 0
  while (start < limit && from.charCodeAt(start) === to.charCodeAt(start)) {
    start += 1
  }
  let end = 0
  while (end < limit - start && from.charCodeAt(from.length - 1 - end) === to.charCodeAt(to.length - 1 - end)) {
    end += 1
  }
  return { from: start, to: from.length - end, insert: to.slice(start, to.length - end) }
}

/** Whether a transaction is an edit made in the editor, which the parent must hear about. */
export const isOwnEdit = (tr: Transaction): boolean => tr.docChanged && tr.annotation(fromValue) !== true

/**
 * Texts the editor reported that the parent may still hand back as `value`. A value it reported
 * is an echo, even a stale one, so it never rolls back typing the parent has not caught up with.
 */
export function createEchoes() {
  let sent: string[] = []
  return {
    sent(text: string): void {
      sent.push(text)
    },
    /** True for an echo of a reported text; any other value clears the record. */
    isEcho(value: string): boolean {
      const at = sent.lastIndexOf(value)
      sent = at < 0 ? [] : sent.slice(at + 1)
      return at >= 0
    },
  }
}

/** A caret from the stand-in textarea, kept inside a document of `length` characters. */
export const clampCaret = ({ anchor, head }: Caret, length: number): Caret => ({
  anchor: Math.min(anchor, length),
  head: Math.min(head, length),
})
