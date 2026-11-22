const PILL = 'a[data-link-url]'

/** A copy of the selection with each link pill replaced by its URL, or null when it holds none. */
function selectionWithUrls(selection: Selection): DocumentFragment | null {
  const copy = document.createDocumentFragment()
  for (let index = 0; index < selection.rangeCount; index++) {
    copy.append(selection.getRangeAt(index).cloneContents())
  }
  const pills = copy.querySelectorAll<HTMLAnchorElement>(PILL)
  if (pills.length === 0) {
    return null
  }
  for (const pill of pills) {
    const url = pill.dataset.linkUrl ?? pill.href
    const link = document.createElement('a')
    link.href = url
    link.textContent = url
    pill.replaceWith(link)
  }
  return copy
}

/** The text and HTML a copy of the fragment carries, laid out as the page shows it. */
function clipboardOf(fragment: DocumentFragment): { text: string; html: string } {
  const stage = document.createElement('div')
  stage.style.cssText = 'position:fixed;left:-10000px;top:0;white-space:pre-wrap'
  stage.append(fragment)
  document.body.append(stage)
  const copied = { text: stage.innerText, html: stage.innerHTML }
  stage.remove()
  return copied
}

function onCopy(event: ClipboardEvent): void {
  const selection = document.getSelection()
  if (selection === null || selection.isCollapsed || event.clipboardData === null) {
    return
  }
  const fragment = selectionWithUrls(selection)
  if (fragment === null) {
    return
  }
  const { text, html } = clipboardOf(fragment)
  event.clipboardData.setData('text/plain', text)
  event.clipboardData.setData('text/html', html)
  event.preventDefault()
}

/** Copying text that holds link pills copies their URLs, not their short labels. */
export function installLinkPillCopy(): void {
  document.addEventListener('copy', onCopy)
}
