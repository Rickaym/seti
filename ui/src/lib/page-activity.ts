import type { PageActivity } from '@/lib/app-build'
import { openDrafts } from '@/lib/drafts'
import { hasUnsavedChanges } from '@/lib/leave-guard'
import { uploadsInFlight } from '@/lib/uploader'

/** A pause in keys and edits this long ends typing. */
const TYPING_MS = 4_000

let lastInput = Number.NEGATIVE_INFINITY

const noteInput = () => {
  lastInput = performance.now()
}

/** Starts noting keys and edits anywhere on the page. */
export function watchTyping(): void {
  for (const type of ['keydown', 'input', 'compositionupdate', 'paste']) {
    window.addEventListener(type, noteInput, { capture: true, passive: true })
  }
}

const dialogOpen = () =>
  [...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]')].some((dialog) =>
    dialog.checkVisibility(),
  )

/** What on the page right now a reload would cut short or throw away. */
export function readActivity(): PageActivity {
  return {
    hidden: document.visibilityState === 'hidden',
    typing: performance.now() - lastInput < TYPING_MS,
    draft: openDrafts.anyText(),
    unkeptText: openDrafts.anyUnkept(),
    dialog: dialogOpen(),
    uploading: uploadsInFlight(),
    unsaved: hasUnsavedChanges(),
  }
}
