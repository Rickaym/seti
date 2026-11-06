import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { javascriptLanguage } from '@codemirror/lang-javascript'
import {
  bracketMatching,
  defineLanguageFacet,
  indentOnInput,
  Language,
  StreamLanguage,
  syntaxHighlighting,
} from '@codemirror/language'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import { EditorView, highlightActiveLineGutter, keymap, lineNumbers } from '@codemirror/view'
import type { CodeLanguage } from '@seti/shared'
import { syntaxHighlighter } from '@seti/shared/highlight'
import { useEffect, useLayoutEffect, useRef } from 'react'
import { changeBetween, clampCaret, createEchoes, fromValue, isOwnEdit, type Caret } from './sync'

const theme = EditorView.theme({
  '&': { flex: '1 1 auto', minHeight: '0', color: 'inherit', backgroundColor: 'transparent' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'inherit', lineHeight: 'inherit', overflow: 'auto' },
  '.cm-content': { padding: '0.5rem 0', caretColor: 'var(--foreground)' },
  '.cm-line': { padding: '0 0.625rem 0 0.5rem' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--muted-foreground)',
    borderRight: '1px solid var(--border)',
  },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 0.5rem 0 0.625rem', minWidth: '2ch' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--foreground)' },
  '&.cm-focused .cm-matchingBracket': {
    backgroundColor: 'color-mix(in oklch, var(--primary) 18%, transparent)',
    outline: '1px solid color-mix(in oklch, var(--primary) 45%, transparent)',
  },
  '&.cm-focused .cm-nonmatchingBracket': {
    backgroundColor: 'transparent',
    color: 'var(--destructive)',
    textDecoration: 'underline wavy',
  },
})

const BASE = [
  lineNumbers(),
  highlightActiveLineGutter(),
  history(),
  indentOnInput(),
  bracketMatching(),
  syntaxHighlighting(syntaxHighlighter),
  keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
  EditorView.lineWrapping,
  theme,
]

/** The grammar for a language: JavaScript is bundled, the rest load with the code highlighter. */
async function grammarOf(language: CodeLanguage | null): Promise<Extension> {
  if (language === null) {
    return []
  }
  if (language === 'javascript') {
    return javascriptLanguage
  }
  if (language === 'diff') {
    const { diff } = await import('@codemirror/legacy-modes/mode/diff')
    return StreamLanguage.define(diff)
  }
  const { parserFor } = await import('@seti/shared/highlight')
  return new Language(defineLanguageFacet(), await parserFor(language), [], language)
}

const fieldAttributes = (label: string, spellCheck: boolean) =>
  EditorView.contentAttributes.of({ 'aria-label': label, spellcheck: spellCheck ? 'true' : 'false' })

interface CodeMirrorEditorProps {
  value: string
  onChange: (value: string) => void
  label: string
  className: string
  /** The stand-in textarea's caret when it had focus at the swap, given once. */
  takeCaret: () => Caret | null
  language: CodeLanguage | null
  spellCheck: boolean
  focusOnMount: boolean
  /** Ctrl+S or Cmd+S in the editor. */
  onSave: (() => void) | undefined
}

/** CodeMirror for code in one language, held in step with its value prop. */
export function CodeMirrorEditor({
  value,
  onChange,
  label,
  className,
  takeCaret,
  language,
  spellCheck,
  focusOnMount,
  onSave,
}: CodeMirrorEditorProps) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const latest = useRef({ value, onChange, label, spellCheck, focusOnMount, onSave, language })
  const echoes = useRef(createEchoes())
  const labelled = useRef(new Compartment())
  const grammar = useRef(new Compartment())

  useLayoutEffect(() => {
    latest.current = { value, onChange, label, spellCheck, focusOnMount, onSave, language }
  })

  useLayoutEffect(() => {
    const parent = host.current
    if (parent === null) {
      return undefined
    }
    const doc = latest.current.value
    const caret = takeCaret()
    const created = new EditorView({
      parent,
      state: EditorState.create({
        doc,
        ...(caret === null ? {} : { selection: clampCaret(caret, doc.length) }),
        extensions: [
          keymap.of([
            {
              key: 'Mod-s',
              preventDefault: true,
              run: () => {
                latest.current.onSave?.()
                return latest.current.onSave !== undefined
              },
            },
          ]),
          BASE,
          grammar.current.of(latest.current.language === 'javascript' ? javascriptLanguage : []),
          labelled.current.of(fieldAttributes(latest.current.label, latest.current.spellCheck)),
          EditorView.updateListener.of((update) => {
            if (update.transactions.some(isOwnEdit)) {
              const text = update.state.doc.toString()
              echoes.current.sent(text)
              latest.current.onChange(text)
            }
          }),
        ],
      }),
    })
    view.current = created
    // Dialogs prevent Esc before CodeMirror sees it, so listen here, prevented or not.
    const escapeRoute = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        created.setTabFocusMode(2000)
      }
    }
    created.dom.addEventListener('keydown', escapeRoute)
    if (caret !== null || latest.current.focusOnMount) {
      created.focus()
    }
    return () => {
      view.current = null
      created.dom.removeEventListener('keydown', escapeRoute)
      created.destroy()
    }
  }, [takeCaret])

  useEffect(() => {
    const current = view.current
    if (current === null || echoes.current.isEcho(value)) {
      return
    }
    const changes = changeBetween(current.state.doc.toString(), value)
    if (changes !== null) {
      current.dispatch({ changes, annotations: fromValue.of(true) })
    }
  }, [value])

  useEffect(() => {
    view.current?.dispatch({ effects: labelled.current.reconfigure(fieldAttributes(label, spellCheck)) })
  }, [label, spellCheck])

  useEffect(() => {
    let live = true
    grammarOf(language).then(
      (extension) => {
        if (live) {
          view.current?.dispatch({ effects: grammar.current.reconfigure(extension) })
        }
      },
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [language])

  return <div ref={host} data-code-editor="" className={className} />
}
