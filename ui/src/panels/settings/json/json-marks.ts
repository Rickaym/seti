import type { Extension } from '@codemirror/state'
import { Decoration, EditorView } from '@codemirror/view'

const problemLine = Decoration.line({ class: 'cm-problemLine' })

const style = EditorView.theme({
  '.cm-problemLine': {
    backgroundColor: 'color-mix(in oklab, var(--destructive) 14%, transparent)',
    boxShadow: 'inset 2px 0 0 var(--destructive)',
  },
})

/** Tints the lines, from 1, that the parser or the server named as wrong. */
export function problemMarks(lines: readonly number[]): Extension {
  const marks = EditorView.decorations.of((view) => {
    const doc = view.state.doc
    const shown = [...new Set(lines)].filter((line) => line >= 1 && line <= doc.lines).toSorted((a, b) => a - b)
    return Decoration.set(shown.map((line) => problemLine.range(doc.line(line).from)))
  })
  return [marks, style]
}
