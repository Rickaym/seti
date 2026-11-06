import type { ResolvedPath } from '@seti/shared'
import { useEffect, useRef, useState, type RefObject } from 'react'
import { relativeTime } from '@/lib/time'
import { cn } from '@/lib/utils'
import { FILE_ICONS, fileLook, isReadable } from '@/panels/files/file-icon'
import { nameOf, rawUrl } from '@/panels/files/files-api'
import { bytesLabel } from '@/panels/resources/format'

const HEAD_BYTES = 2048
const HEAD_LINES = 4
/** What the decoder makes of a character the byte range cut in two. */
const CUT_CHARACTER = String.fromCodePoint(0xfffd)

const heads = new Map<string, Promise<string | null>>()

/** The first lines of a text file, from one ranged read of its first bytes; null for binary. */
async function readHead(url: string): Promise<string | null> {
  const res = await fetch(url, { headers: { Range: `bytes=0-${String(HEAD_BYTES - 1)}` } })
  if (!res.ok) {
    return null
  }
  const bytes = new Uint8Array(await res.arrayBuffer()).subarray(0, HEAD_BYTES)
  if (bytes.includes(0)) {
    return null
  }
  const text = new TextDecoder().decode(bytes)
  const whole = text.endsWith(CUT_CHARACTER) ? text.slice(0, -1) : text
  const lines = whole.split(/\r?\n/).slice(0, HEAD_LINES).join('\n').trimEnd()
  return lines === '' ? null : lines
}

async function headOf(url: string): Promise<string | null> {
  const known = heads.get(url)
  if (known !== undefined) {
    return known
  }
  const asked = readHead(url).catch(() => null)
  heads.set(url, asked)
  return asked
}

/** Whether the element has come near the screen once, so work for it can wait until then. */
function useSeen(ref: RefObject<HTMLElement | null>, wanted: boolean): boolean {
  const [seen, setSeen] = useState(false)
  useEffect(() => {
    const element = ref.current
    if (!wanted || seen || element === null) {
      return undefined
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setSeen(true)
        }
      },
      { rootMargin: '200px' },
    )
    observer.observe(element)
    return () => {
      observer.disconnect()
    }
  }, [ref, wanted, seen])
  return seen
}

function useHead(url: string | null, seen: boolean): string | null {
  const [head, setHead] = useState<{ url: string; text: string | null } | null>(null)
  useEffect(() => {
    if (url === null || !seen) {
      return undefined
    }
    let live = true
    void headOf(url).then((text) => {
      if (live) {
        setHead({ url, text })
      }
    })
    return () => {
      live = false
    }
  }, [url, seen])
  return head !== null && head.url === url ? head.text : null
}

/** A file posted on a line of its own: icon, name, path, size and age, and a text file's top. */
export function FileCard({
  found,
  shown,
  taskId,
  onOpen,
}: {
  found: ResolvedPath
  shown: string
  /** The task whose Files serves the bytes; null skips the preview. */
  taskId: string | null
  onOpen: () => void
}) {
  const ref = useRef<HTMLButtonElement>(null)
  const Icon = FILE_ICONS[fileLook(found.path, found.type)]
  const readable = found.type === 'file' && taskId !== null && isReadable(found.path) && found.size !== 0
  const url = readable ? rawUrl(taskId, found, { dotfiles: false, version: found.mtime }) : null
  const head = useHead(url, useSeen(ref, url !== null))
  const detail =
    found.size === undefined || found.mtime === undefined
      ? null
      : `${bytesLabel(found.size)}, changed ${relativeTime(found.mtime)}`
  return (
    <button
      ref={ref}
      type="button"
      aria-label={`Open ${shown} in Files`}
      data-file-link={found.path}
      data-file-card=""
      onClick={onOpen}
      className={cn(
        'flex w-full max-w-md cursor-pointer items-start gap-3 rounded-md border border-border bg-card p-2.5 text-left',
        'transition-colors hover:border-primary/40 hover:bg-primary/5',
        'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring',
      )}
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-sm bg-primary/10 text-primary">
        <Icon aria-hidden className="size-4.5" />
      </span>
      <span className="block min-w-0 flex-1">
        <span className="block truncate text-sm leading-snug font-medium text-foreground">{nameOf(found.path)}</span>
        <span className="block truncate text-2xs text-muted-foreground">{shown}</span>
        {detail !== null && <span className="block text-2xs text-muted-foreground">{detail}</span>}
        {head !== null && (
          <span
            data-file-head=""
            className="mt-2 block overflow-hidden border-l-2 border-primary/30 bg-code/60 py-1 pr-2 pl-2 font-mono text-2xs leading-snug whitespace-pre text-foreground/80"
          >
            {head}
          </span>
        )}
      </span>
    </button>
  )
}
