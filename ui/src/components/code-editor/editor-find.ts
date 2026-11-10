import {
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll,
  replaceNext,
  search,
  SearchQuery,
  setSearchQuery,
} from '@codemirror/search'
import { RangeSetBuilder, type EditorState } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import type { FindCount, FindQuery, FindTarget } from '@/lib/text-find'

/** The find bar an editor serves: what to mark, where its commands go, and the count. */
export interface EditorFind {
  query: FindQuery | null
  /** Hands the bar the editor's commands; returns the call that takes them back. */
  attach: (target: FindTarget) => () => void
  onCount: (count: FindCount | null) => void
}

/** Counting stops here, so a one-letter query in a long file stays quick. */
const COUNT_MAX = 1000

const match = Decoration.mark({ class: 'cm-findMatch' })
const current = Decoration.mark({ class: 'cm-findMatch-current' })

function matchMarks(view: EditorView): DecorationSet {
  const query = getSearchQuery(view.state)
  if (!query.valid) {
    return Decoration.none
  }
  const { from: selFrom, to: selTo } = view.state.selection.main
  const builder = new RangeSetBuilder<Decoration>()
  for (const { from, to } of view.visibleRanges) {
    const cursor = query.getCursor(view.state, from, to)
    for (let step = cursor.next(); step.done !== true; step = cursor.next()) {
      const found = step.value
      builder.add(found.from, found.to, found.from === selFrom && found.to === selTo ? current : match)
    }
  }
  return builder.finish()
}

const queryChanged = (update: ViewUpdate) => !getSearchQuery(update.startState).eq(getSearchQuery(update.state))

/** Marks the query's matches on screen while find is open, the selected one stronger. */
const findMarks = ViewPlugin.define(
  (view) => {
    let decorations = matchMarks(view)
    return {
      get decorations() {
        return decorations
      },
      update(update: ViewUpdate) {
        if (update.docChanged || update.selectionSet || update.viewportChanged || queryChanged(update)) {
          decorations = matchMarks(update.view)
        }
      },
    }
  },
  { decorations: (plugin) => plugin.decorations },
)

/** Search state for the find bar; it never opens CodeMirror's own panel. */
export const editorFind = [
  search({ scrollToMatch: (range) => EditorView.scrollIntoView(range, { y: 'center' }) }),
  findMarks,
]

/** How many matches the file holds and which one is selected, or null with no query. */
export function countMatches(state: EditorState): FindCount | null {
  const query = getSearchQuery(state)
  if (!query.valid) {
    return null
  }
  const { from, to } = state.selection.main
  const cursor = query.getCursor(state)
  let total = 0
  let index = -1
  for (let step = cursor.next(); step.done !== true; step = cursor.next()) {
    if (total === COUNT_MAX) {
      return { index, total, capped: true }
    }
    if (step.value.from === from && step.value.to === to) {
      index = total
    }
    total += 1
  }
  return { index, total, capped: false }
}

/** The first match at or after `from`, wrapping to the top. */
function nearest(state: EditorState, query: SearchQuery, from: number): { from: number; to: number } | null {
  const after = query.getCursor(state, from).next()
  if (after.done !== true) {
    return after.value
  }
  const top = query.getCursor(state).next()
  return top.done === true ? null : top.value
}

const specOf = (query: FindQuery | null, replace = '') =>
  new SearchQuery({ search: query?.text ?? '', caseSensitive: query?.caseSensitive ?? false, literal: true, replace })

/** Marks `query` in the editor and selects its nearest match as the user types it. */
export function applyQuery(view: EditorView, query: FindQuery | null): void {
  const spec = specOf(query)
  const was = getSearchQuery(view.state)
  if (was.search === spec.search && was.caseSensitive === spec.caseSensitive) {
    return
  }
  const found = spec.valid ? nearest(view.state, spec, view.state.selection.main.from) : null
  view.dispatch({
    effects: [
      setSearchQuery.of(spec),
      ...(found === null ? [] : [EditorView.scrollIntoView(found.from, { y: 'center' })]),
    ],
    ...(found === null ? {} : { selection: { anchor: found.from, head: found.to } }),
  })
}

/** Runs a replace command with `replacement` as the query's replacement text. */
function withReplacement(view: EditorView, replacement: string, command: (view: EditorView) => boolean): void {
  const was = getSearchQuery(view.state)
  if (!was.valid) {
    return
  }
  const query = { text: was.search, caseSensitive: was.caseSensitive }
  view.dispatch({ effects: setSearchQuery.of(specOf(query, replacement)) })
  command(view)
}

/** Find, replace and go to line in `view`, for the find bar. */
export function editorFindTarget(view: EditorView): FindTarget {
  const valid = () => getSearchQuery(view.state).valid
  return {
    next: () => {
      if (valid()) {
        findNext(view)
      }
    },
    previous: () => {
      if (valid()) {
        findPrevious(view)
      }
    },
    replace: (replacement) => {
      withReplacement(view, replacement, replaceNext)
    },
    replaceAll: (replacement) => {
      withReplacement(view, replacement, replaceAll)
    },
    goToLine: (number) => {
      const line = view.state.doc.line(Math.min(Math.max(1, number), view.state.doc.lines))
      view.dispatch({
        selection: { anchor: line.from },
        effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
      })
      view.focus()
    },
    selection: () => {
      const { from, to } = view.state.selection.main
      return view.state.sliceDoc(from, to)
    },
    focus: () => {
      view.focus()
    },
  }
}
