import { readWorkbook } from './sheets'

/** Parses a workbook off the main thread, so a large one never freezes the page. */
// eslint-disable-next-line sonarjs/post-message -- a dedicated worker hears only the page that made it
self.addEventListener('message', (event: MessageEvent<ArrayBuffer>) => {
  try {
    self.postMessage({ sheets: readWorkbook(event.data) })
  } catch (e) {
    self.postMessage({ error: e instanceof Error ? e.message : String(e) })
  }
})
