import type { ISearchOptions, SearchAddon } from '@xterm/addon-search'
import type { Terminal } from '@xterm/xterm'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { matchLabel } from './terminal-find'

/** Match highlights in the terminal's own theme colours, which the addon needs as hex. */
function searchOptions(term: Terminal): ISearchOptions {
  const { selectionBackground, yellow } = term.options.theme ?? {}
  if (selectionBackground === undefined || yellow === undefined) {
    return {}
  }
  const decorations = {
    matchBackground: selectionBackground,
    matchOverviewRuler: selectionBackground,
    activeMatchBackground: yellow,
    activeMatchColorOverviewRuler: yellow,
  }
  return { decorations }
}

/** Finds text in the output: Enter steps to the next match, Shift+Enter back, Esc closes. */
export function TerminalSearch({
  term,
  search,
  onClose,
}: {
  term: Terminal
  search: SearchAddon
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState({ index: -1, count: 0 })
  const field = useRef<HTMLInputElement>(null)
  const options = searchOptions(term)
  useEffect(() => {
    field.current?.focus()
  }, [])
  useEffect(() => {
    const changed = search.onDidChangeResults(({ resultIndex, resultCount }) => {
      setResults({ index: resultIndex, count: resultCount })
    })
    return () => {
      changed.dispose()
      search.clearDecorations()
    }
  }, [search])
  const close = () => {
    onClose()
    term.focus()
  }
  const step = (back: boolean) => {
    if (query !== '') {
      if (back) {
        search.findPrevious(query, options)
      } else {
        search.findNext(query, options)
      }
    }
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation()
    if (event.key === 'Enter') {
      event.preventDefault()
      step(event.shiftKey)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      close()
    }
  }
  return (
    <search className="absolute top-2 right-3 z-10 flex items-center gap-1 border border-border bg-background p-1 shadow-md">
      <Input
        ref={field}
        type="search"
        aria-label="Find in terminal"
        placeholder="Find"
        className="h-8 w-44"
        value={query}
        onChange={(event) => {
          const next = event.target.value
          setQuery(next)
          if (next === '') {
            search.clearDecorations()
            setResults({ index: -1, count: 0 })
          } else {
            search.findNext(next, { ...options, incremental: true })
          }
        }}
        onKeyDown={onKeyDown}
      />
      <span role="status" className="min-w-16 text-center text-2xs text-muted-foreground">
        {query === '' ? '' : matchLabel(results.index, results.count)}
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Previous match"
        onClick={() => {
          step(true)
        }}
      >
        <ChevronUp />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Next match"
        onClick={() => {
          step(false)
        }}
      >
        <ChevronDown />
      </Button>
      <Button variant="ghost" size="icon-sm" aria-label="Close find" onClick={close}>
        <X />
      </Button>
    </search>
  )
}
