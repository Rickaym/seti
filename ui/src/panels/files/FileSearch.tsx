import type { FileNameHit, FileRoot, FileSearch, FileTextHit } from '@seti/shared'
import { File, Folder, Regex, Search, TextSearch, X } from 'lucide-react'
import type { ReactNode, RefObject } from 'react'
import { Hint } from '@/components/Hint'
import { ToggleButton } from '@/components/ToggleButton'
import { FIND_SHORTCUT } from '@/components/shortcuts/find'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { nameOf, parentOf } from '@/panels/files/files-api'
import { pickOf, type FileSearchState, type SearchPick } from '@/panels/files/useFileSearch'

const MARK = 'rounded-xs bg-warning/30 text-inherit'

/** Text with the characters in `marks`, given as [start, end) ranges, highlighted. */
function Marked({ text, marks }: { text: string; marks: readonly (readonly [number, number])[] }) {
  const parts: ReactNode[] = []
  let at = 0
  for (const [start, end] of marks) {
    if (start < at || start >= end) {
      continue
    }
    parts.push(
      text.slice(at, start),
      <mark key={start} className={MARK}>
        {text.slice(start, end)}
      </mark>,
    )
    at = end
  }
  parts.push(text.slice(at))
  return <>{parts}</>
}

/** Runs of consecutive indexes in `marks` within [from, to), as ranges relative to `from`. */
function rangesOf(marks: readonly number[], from: number, to: number): [number, number][] {
  const ranges: [number, number][] = []
  for (const mark of marks) {
    if (mark < from || mark >= to) {
      continue
    }
    const last = ranges.at(-1)
    if (last?.[1] === mark - from) {
      last[1] += 1
    } else {
      ranges.push([mark - from, mark - from + 1])
    }
  }
  return ranges
}

interface SearchBarProps {
  search: FileSearchState
  field: RefObject<HTMLInputElement | null>
  /** The field took focus or input, so results should show. */
  onActive: () => void
  /** Enter in the field: open the first result. */
  onSubmit: () => void
  /** Esc in the field: clear the query and hide the search. */
  onClose: () => void
}

/** The search field, with its clear button and the Text and Regex toggles. */
export function SearchBar({ search, field, onActive, onSubmit, onClose }: SearchBarProps) {
  const text = search.mode === 'text'
  const label = text ? 'Search inside files' : 'Search files by name'
  return (
    <div role="search" className="flex shrink-0 items-center gap-1.5 border-b border-border px-3 py-2">
      <div className="relative min-w-0 flex-1">
        <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={field}
          value={search.query}
          aria-label={label}
          placeholder={`${label} (${FIND_SHORTCUT})`}
          autoComplete="off"
          spellCheck={false}
          className="h-7 pr-7 pl-7"
          onFocus={onActive}
          onChange={(e) => {
            search.setQuery(e.target.value)
            onActive()
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              onSubmit()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              e.stopPropagation()
              onClose()
            }
          }}
        />
        {search.query !== '' && (
          <Hint text="Clear the search">
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Clear search"
              className="absolute top-1/2 right-0.5 -translate-y-1/2"
              onClick={() => {
                search.setQuery('')
                field.current?.focus()
              }}
            >
              <X />
            </Button>
          </Hint>
        )}
      </div>
      <ToggleButton
        pressed={text}
        onPressedChange={(pressed) => {
          search.setMode(pressed ? 'text' : 'name')
          onActive()
        }}
        icon={TextSearch}
        label="Text"
        hint={text ? 'Searching inside files; click to search names' : 'Search inside files, not their names'}
      />
      {text && (
        <ToggleButton
          pressed={search.regex}
          onPressedChange={(pressed) => {
            search.setRegex(pressed)
            onActive()
          }}
          icon={Regex}
          label="Regex"
          iconOnly
          hint={search.regex ? 'Reading the query as a regular expression' : 'Read the query as a regular expression'}
        />
      )}
    </div>
  )
}

const ROW = 'flex w-full items-start gap-2 border-b border-border px-3 py-1.5 text-left hover:bg-accent'

function NameRow({ hit, rootLabel, onPick }: { hit: FileNameHit; rootLabel: string; onPick: () => void }) {
  const Icon = hit.type === 'dir' ? Folder : File
  const nameStart = hit.path.length - nameOf(hit.path).length
  const folder = parentOf(hit.path)
  return (
    <button type="button" className={ROW} onClick={onPick}>
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">
          <Marked text={nameOf(hit.path)} marks={rangesOf(hit.marks, nameStart, hit.path.length)} />
        </span>
        <span className="block truncate text-2xs text-muted-foreground">
          {rootLabel}
          {folder !== '' && ' / '}
          <Marked text={folder} marks={rangesOf(hit.marks, 0, folder.length)} />
        </span>
      </span>
    </button>
  )
}

function TextRow({ hit, rootLabel, onPick }: { hit: FileTextHit; rootLabel: string; onPick: () => void }) {
  return (
    <button type="button" className={ROW} onClick={onPick}>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-2xs text-muted-foreground">
          {rootLabel} / {hit.path}:{hit.line}
        </span>
        <span className="block truncate font-mono text-xs [font-variant-ligatures:none]">
          <Marked text={hit.text} marks={hit.marks} />
        </span>
      </span>
    </button>
  )
}

function Footer({ result }: { result: FileSearch }) {
  const notes = [
    result.truncated && `Showing the first ${String(result.hits.length)} matches; refine the search for more.`,
    result.partial && 'The search stopped early, so some files were not searched.',
  ].filter((note) => note !== false)
  if (notes.length === 0) {
    return null
  }
  return <p className="shrink-0 border-t border-border px-3 py-1.5 text-2xs text-muted-foreground">{notes.join(' ')}</p>
}

interface SearchResultsProps {
  search: FileSearchState
  roots: readonly FileRoot[]
  onPick: (pick: SearchPick) => void
}

/** The hits of the search as a flat list, or why there are none. */
export function SearchResults({ search, roots, onPick }: SearchResultsProps) {
  const { result, error } = search
  const status = (text: string, tone = 'text-muted-foreground') => (
    <p role="status" className={cn('p-4 text-sm', tone)}>
      {text}
    </p>
  )
  if (error !== null) {
    return status(error, 'text-destructive')
  }
  if (result === null) {
    return status('Searching...')
  }
  if (result.hits.length === 0) {
    const what = result.mode === 'text' ? 'No lines in the files match' : 'No file or folder names match'
    return status(search.searching ? 'Searching...' : `${what} "${search.query.trim()}".`)
  }
  const labelOf = (id: string) => roots.find((root) => root.id === id)?.label ?? id
  return (
    <>
      <ul className="min-h-0 flex-1 overflow-y-auto" aria-label="Search results" aria-busy={search.searching}>
        {result.mode === 'name'
          ? result.hits.map((hit) => (
              <li key={`${hit.root}:${hit.path}`}>
                <NameRow
                  hit={hit}
                  rootLabel={labelOf(hit.root)}
                  onPick={() => {
                    onPick(pickOf(hit))
                  }}
                />
              </li>
            ))
          : result.hits.map((hit) => (
              <li key={`${hit.root}:${hit.path}:${String(hit.line)}`}>
                <TextRow
                  hit={hit}
                  rootLabel={labelOf(hit.root)}
                  onPick={() => {
                    onPick(pickOf(hit))
                  }}
                />
              </li>
            ))}
      </ul>
      <Footer result={result} />
    </>
  )
}
