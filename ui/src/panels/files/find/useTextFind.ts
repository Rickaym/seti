import { useEffect, useMemo, useState } from 'react'
import type { EditorFind } from '@/components/code-editor/editor-find'
import { useEditorFind } from '@/components/find/useEditorFind'
import { useFind, type FindState } from '@/components/find/useFind'
import { useFindKeys } from '@/components/find/useFindKeys'
import type { FindTarget } from '@/lib/text-find'
import type { FileViewerEntry } from '@/panels/files/file-viewers'
import { useViewFind } from '@/panels/files/find/useViewFind'

interface TextFind {
  find: FindState
  /** The editor or the view shows text find can search; a rendered viewer such as a table does not. */
  readable: boolean
  /** What the editor serves while editing. */
  editorFind: EditorFind
  /** The open file's box, whose keys find takes. */
  rootRef: (element: HTMLElement | null) => void
  /** The read-only view's box, which find searches. */
  viewRef: (element: HTMLElement | null) => void
  /** The line the view marks: the one go to line picked, else the one the file opened at. */
  line: number | null
}

/** A line picked with go to line, kept until the file is opened at another line. */
interface Jump {
  line: number
  from: number | null
}

interface Shown {
  editing: boolean
  /** The viewer on screen, or undefined for the text itself. */
  viewer: FileViewerEntry | undefined
  markdown: boolean
  /** The line the file opened at, from a search. */
  openedAt: number | null
}

/** Find, replace and go to line for one open text file, in its editor or its read-only view. */
export function useTextFind({ editing, viewer, markdown, openedAt }: Shown): TextFind {
  const find = useFind()
  const { query, setCount } = find
  const { attach, editorFind } = useEditorFind(find)
  const readable = editing || viewer === undefined
  const offers = { find: readable, replace: editing, line: editing || (readable && !markdown) }
  const [root, setRoot] = useState<HTMLElement | null>(null)
  const [view, setView] = useState<HTMLElement | null>(null)
  const [jump, setJump] = useState<Jump | null>(null)
  const shown = editing ? null : view
  const { next, previous, selection } = useViewFind(shown, readable ? query : null, setCount)
  useFindKeys(root, find, offers)

  const viewTarget = useMemo<FindTarget | null>(
    () =>
      shown === null
        ? null
        : {
            next,
            previous,
            selection,
            goToLine: (line) => {
              setJump({ line, from: openedAt })
              requestAnimationFrame(() => {
                shown.querySelector('mark[data-line]')?.scrollIntoView({ block: 'center' })
              })
            },
            focus: () => {
              shown.focus({ preventScroll: true })
            },
          },
    [shown, next, previous, selection, openedAt],
  )
  useEffect(() => (viewTarget === null ? undefined : attach(viewTarget)), [viewTarget, attach])
  return {
    find,
    readable,
    editorFind,
    rootRef: setRoot,
    viewRef: setView,
    line: jump !== null && jump.from === openedAt ? jump.line : openedAt,
  }
}
