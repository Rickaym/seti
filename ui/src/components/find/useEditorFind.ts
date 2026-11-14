import { useCallback, useMemo } from 'react'
import type { EditorFind } from '@/components/code-editor/editor-find'
import type { FindState } from '@/components/find/useFind'
import type { FindTarget } from '@/lib/text-find'

interface EditorFindLink {
  /** Hands `find` a text's commands; returns the call that takes them back. */
  attach: (target: FindTarget) => () => void
  /** What a code editor serves this find. */
  editorFind: EditorFind
}

/** Connects `find` to the code editor, or the view, that shows its text. */
export function useEditorFind(find: FindState): EditorFindLink {
  const { query, target: targetRef, setCount } = find
  const attach = useCallback(
    (given: FindTarget) => {
      targetRef.current = given
      return () => {
        if (targetRef.current === given) {
          targetRef.current = null
        }
      }
    },
    [targetRef],
  )
  const editorFind = useMemo(() => ({ query, attach, onCount: setCount }), [query, attach, setCount])
  return { attach, editorFind }
}
