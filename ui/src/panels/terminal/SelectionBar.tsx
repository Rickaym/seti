import type { Terminal } from '@xterm/xterm'
import { ClipboardPaste, Copy, ExternalLink, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { copySelection, pasteClipboard } from './terminal-clipboard'
import { selectedUrl } from './terminal-select'

/** Keeps a press on the bar from taking focus, so the keyboard stays as it was. */
const keep = (event: { preventDefault: () => void }) => {
  event.preventDefault()
}

/** What a long press selected: copy it, paste over the prompt, or open it when it is a link. */
export function SelectionBar({ term, text, onDone }: { term: Terminal; text: string; onDone: () => void }) {
  const url = selectedUrl(text)
  return (
    <div
      role="toolbar"
      aria-label="Selection"
      className="absolute top-2 right-2 z-10 flex gap-1 border border-border bg-background p-1 shadow-md"
    >
      <Button
        variant="ghost"
        size="sm"
        onPointerDown={keep}
        onClick={() => {
          void copySelection(term)
          onDone()
        }}
      >
        <Copy />
        Copy
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onPointerDown={keep}
        onClick={() => {
          term.clearSelection()
          void pasteClipboard(term)
          onDone()
        }}
      >
        <ClipboardPaste />
        Paste
      </Button>
      {url !== null && (
        <Button
          variant="ghost"
          size="sm"
          onPointerDown={keep}
          onClick={() => {
            window.open(url, '_blank', 'noopener,noreferrer')
            term.clearSelection()
            onDone()
          }}
        >
          <ExternalLink />
          Open
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Clear selection"
        onPointerDown={keep}
        onClick={() => {
          term.clearSelection()
          onDone()
        }}
      >
        <X />
      </Button>
    </div>
  )
}
