import type { FileListing, FileRoot, FileSort, RecentFiles } from '@seti/shared'
import { ArrowDownAZ, ChevronRight, Eye, FileCog, FilePlus, RefreshCw, Search, X } from 'lucide-react'
import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react'
import { toast } from 'sonner'
import { apiGet, errorText } from '@/api'
import { Hint } from '@/components/Hint'
import { ToggleButton } from '@/components/ToggleButton'
import { FIND_SHORTCUT, isFindShortcut } from '@/components/shortcuts/find'
import { Button } from '@/components/ui/button'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { mayLeave } from '@/lib/leave-guard'
import { PANEL } from '@/lib/panels'
import { startPolling } from '@/lib/poll-loop'
import { FileList, type ListedEntry } from '@/panels/files/FileList'
import { SearchBar, SearchResults } from '@/panels/files/FileSearch'
import { FileViewer, type OpenFile } from '@/panels/files/FileViewer'
import { NewFileForm } from '@/panels/files/NewFileForm'
import { filesLinkUrl, filesPath, parentOf, type FileTarget } from '@/panels/files/files-api'
import { storedShowSetiFiles, storeShowSetiFiles } from '@/panels/files/seti-files'
import { firstPick, useFileSearch, type SearchPick } from '@/panels/files/useFileSearch'
import { useFileWatch } from '@/panels/files/useFileWatch'

const RECENT = 'recent'
const RECENT_LIMIT = 100
const RECENT_POLL_MS = 15_000

/** What the panel was asked to show: a file or folder, or null for the recent files. */
export interface FilesRequest {
  target: FileTarget | null
  /** Grows with every request, so asking for the same file again still navigates. */
  seq: number
}

interface Place {
  root: string
  dir: string
}

const placeOf = (target: FileTarget | null): Place =>
  target === null
    ? { root: RECENT, dir: '' }
    : { root: target.root, dir: target.type === 'dir' ? target.path : parentOf(target.path) }

const fileOf = (target: FileTarget | null): OpenFile | null =>
  target?.type === 'file' ? { target, creating: false } : null

const byName = (a: ListedEntry, b: ListedEntry) =>
  a.name.localeCompare(b.name, 'en', { numeric: true, sensitivity: 'base' })

function Breadcrumb({ root, dir, onGo }: { root: FileRoot | undefined; dir: string; onGo: (dir: string) => void }) {
  if (root === undefined) {
    return <span className="text-muted-foreground">Changed since the agent started</span>
  }
  const parts = dir === '' ? [] : dir.split('/')
  return (
    <nav aria-label="Folder" className="flex min-w-0 flex-wrap items-center gap-0.5">
      <button
        type="button"
        className="hover:underline"
        title={root.path}
        onClick={() => {
          onGo('')
        }}
      >
        {root.label}
      </button>
      {parts.map((part, index) => {
        const to = parts.slice(0, index + 1).join('/')
        return (
          <span key={to} className="flex items-center gap-0.5">
            <ChevronRight className="size-3 text-muted-foreground" />
            <button
              type="button"
              className="hover:underline"
              onClick={() => {
                onGo(to)
              }}
            >
              {part}
            </button>
          </span>
        )
      })}
    </nav>
  )
}

interface Listing {
  entries: ListedEntry[] | null
  error: string | null
  refresh: () => void
}

interface ListingQuery {
  taskId: string
  place: Place
  sort: FileSort
  dotfiles: boolean
  setiFiles: boolean
  /** The list is on screen rather than an open file. */
  showing: boolean
}

/** The recent files or a folder's entries, kept fresh while the list shows. */
function useListing({ taskId, place, sort, dotfiles, setiFiles, showing }: ListingQuery): Listing {
  const [state, setState] = useState<Omit<Listing, 'refresh'>>({ entries: null, error: null })
  const [tick, setTick] = useState(0)
  const refresh = useCallback(() => {
    setTick((n) => n + 1)
  }, [])

  useEffect(() => {
    let live = true
    const loading =
      place.root === RECENT
        ? apiGet<RecentFiles>(filesPath(taskId, 'recent', { limit: String(RECENT_LIMIT), seti_files: setiFiles })).then(
            (recent): ListedEntry[] => (sort === 'name' ? recent.files.toSorted(byName) : recent.files),
          )
        : apiGet<FileListing>(
            filesPath(taskId, 'list', { root: place.root, path: place.dir, sort, dotfiles, seti_files: setiFiles }),
          ).then((listing) => listing.entries.map((entry) => ({ ...entry, root: place.root })))
    loading.then(
      (entries) => {
        if (live) {
          setState({ entries, error: null })
        }
      },
      (e: unknown) => {
        if (live) {
          setState({ entries: null, error: errorText(e) })
        }
      },
    )
    return () => {
      live = false
    }
  }, [taskId, place, sort, dotfiles, setiFiles, tick])

  const browsing = showing && place.root !== RECENT
  useFileWatch(browsing ? { taskId, root: place.root, path: place.dir, dotfiles } : null, refresh)
  useEffect(() => {
    if (!showing || place.root !== RECENT) {
      return undefined
    }
    return startPolling(refresh, RECENT_POLL_MS)
  }, [showing, place.root, refresh])

  return { ...state, refresh }
}

function ListBody({
  taskId,
  listing,
  roots,
  recent,
  onOpen,
}: {
  taskId: string
  listing: Listing
  roots: readonly FileRoot[]
  recent: boolean
  onOpen: (entry: ListedEntry) => void
}) {
  if (listing.error !== null) {
    return <p className="p-4 text-sm text-destructive">{listing.error}</p>
  }
  if (listing.entries === null) {
    return <p className="p-4 text-sm text-muted-foreground">Loading...</p>
  }
  return (
    <FileList
      entries={listing.entries}
      roots={roots}
      showWhere={recent}
      empty={recent ? 'No files changed since the agent started.' : 'This folder is empty.'}
      onOpen={onOpen}
      linkOf={(entry) => filesLinkUrl(taskId, entry)}
    />
  )
}

interface FilesPanelProps {
  taskId: string
  request: FilesRequest
  /** An archived agent's files are shown but not saved. */
  readOnly: boolean
  onClose: () => void
}

/** The agent's files: what changed lately or a folder of one of its roots, and one open file. */
export function FilesPanel({ taskId, request, readOnly, onClose }: FilesPanelProps) {
  const [roots, setRoots] = useState<FileRoot[]>([])
  const [place, setPlace] = useState<Place>(() => placeOf(request.target))
  const [open, setOpen] = useState<OpenFile | null>(() => fileOf(request.target))
  const [sort, setSort] = useState<FileSort>('recent')
  const [dotfiles, setDotfiles] = useState(false)
  const [setiFiles, setSetiFiles] = useState(storedShowSetiFiles)
  const [naming, setNaming] = useState(false)
  const listing = useListing({ taskId, place, sort, dotfiles, setiFiles, showing: open === null })
  const search = useFileSearch(taskId, { dotfiles, setiFiles })
  const [resultsShown, setResultsShown] = useState(false)
  const [searching, setSearching] = useState(false)
  const [focusAsks, setFocusAsks] = useState(0)
  const showResults = searching && resultsShown && search.query.trim() !== ''
  const section = useRef<HTMLElement>(null)
  const field = useRef<HTMLInputElement>(null)

  const openSearch = useCallback(() => {
    setSearching(true)
    setFocusAsks((n) => n + 1)
  }, [])
  const closeSearch = () => {
    search.setQuery('')
    setSearching(false)
    setResultsShown(false)
    section.current?.focus()
  }

  useEffect(() => {
    if (focusAsks > 0) {
      field.current?.focus()
      field.current?.select()
    }
  }, [focusAsks])

  useEffect(() => {
    const element = section.current
    const onKeyDown = (e: KeyboardEvent) => {
      if (isFindShortcut(e)) {
        e.preventDefault()
        openSearch()
      }
    }
    element?.addEventListener('keydown', onKeyDown)
    return () => {
      element?.removeEventListener('keydown', onKeyDown)
    }
  }, [openSearch])

  useEffect(() => {
    apiGet<FileRoot[]>(filesPath(taskId, 'roots')).then(setRoots, (e: unknown) => {
      toast.error(errorText(e))
    })
  }, [taskId])

  const go = async (next: Place, file: OpenFile | null) => {
    if (!(await mayLeave())) {
      return
    }
    setNaming(false)
    setResultsShown(false)
    setPlace(next)
    setOpen(file)
  }

  const follow = useEffectEvent((next: FilesRequest) => {
    void go(placeOf(next.target), fileOf(next.target))
  })
  const seen = useRef(request.seq)
  useEffect(() => {
    if (request.seq !== seen.current) {
      seen.current = request.seq
      follow(request)
    }
  }, [request])

  const root = roots.find((entry) => entry.id === place.root)
  const writableRoot = (id: string) => !readOnly && roots.find((entry) => entry.id === id)?.writable === true
  const openEntry = (entry: ListedEntry) => {
    const target: FileTarget = { root: entry.root, path: entry.path, type: entry.type }
    void go(entry.type === 'dir' ? { root: entry.root, dir: entry.path } : place, fileOf(target))
  }

  const pick = ({ line, ...target }: SearchPick) => {
    void go(placeOf(target), target.type === 'file' ? { target, creating: false, line } : null)
  }

  return (
    <section
      ref={section}
      aria-label="Files"
      {...PANEL}
      tabIndex={-1}
      className="flex h-full min-h-0 flex-col bg-background outline-none"
    >
      {searching && (
        <SearchBar
          search={search}
          field={field}
          onActive={() => {
            setResultsShown(true)
          }}
          onSubmit={() => {
            const first = firstPick(search.result)
            if (first !== null) {
              pick(first)
            }
          }}
          onClose={closeSearch}
        />
      )}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-3 py-2">
        <NativeSelect
          size="sm"
          aria-label="Root"
          value={place.root}
          onChange={(e) => void go({ root: e.target.value, dir: '' }, null)}
          className="max-w-48 min-w-0"
        >
          <NativeSelectOption value={RECENT}>Recent</NativeSelectOption>
          {roots.map((entry) => (
            <NativeSelectOption key={entry.id} value={entry.id} disabled={!entry.exists}>
              {entry.label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <ToggleButton
          pressed={searching}
          onPressedChange={(show) => {
            if (show) {
              openSearch()
            } else {
              closeSearch()
            }
          }}
          icon={Search}
          label="Search files"
          iconOnly
          hint={searching ? 'Close the search (Esc)' : `Search names and text (${FIND_SHORTCUT})`}
        />
        <ToggleButton
          pressed={sort === 'name'}
          onPressedChange={(named) => {
            setSort(named ? 'name' : 'recent')
          }}
          icon={ArrowDownAZ}
          label="By name"
          iconOnly
          hint={sort === 'name' ? 'Sorted by name; click to sort by recent change' : 'Sort by name, not recent change'}
        />
        <ToggleButton
          pressed={dotfiles}
          onPressedChange={setDotfiles}
          icon={Eye}
          label="Dot files"
          iconOnly
          hint={dotfiles ? 'Showing dot files; hidden paths stay hidden' : 'Show dot files such as .env'}
        />
        <ToggleButton
          pressed={setiFiles}
          onPressedChange={(show) => {
            storeShowSetiFiles(show)
            setSetiFiles(show)
          }}
          icon={FileCog}
          label="Seti files"
          iconOnly
          hint={setiFiles ? 'Showing files Seti writes, such as members.md' : 'Show files Seti writes, such as task.md'}
        />
        {open === null && place.root !== RECENT && writableRoot(place.root) && (
          <Hint text="New text file in this folder">
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="New file"
              onClick={() => {
                setNaming(true)
              }}
            >
              <FilePlus />
            </Button>
          </Hint>
        )}
        <Hint text="Refresh">
          <Button variant="outline" size="icon-sm" aria-label="Refresh" onClick={listing.refresh}>
            <RefreshCw />
          </Button>
        </Hint>
        <Hint text="Close Files">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Close Files"
            className="ml-auto"
            onClick={() => {
              void mayLeave().then((ok) => {
                if (ok) {
                  onClose()
                }
              })
            }}
          >
            <X />
          </Button>
        </Hint>
      </div>
      <div className="shrink-0 border-b border-border px-3 py-1.5 text-xs">
        <Breadcrumb root={root} dir={place.dir} onGo={(dir) => void go({ root: place.root, dir }, null)} />
      </div>
      {naming && (
        <NewFileForm
          onCancel={() => {
            setNaming(false)
          }}
          onCreate={(name) => {
            const path = place.dir === '' ? name : `${place.dir}/${name}`
            void go(place, { target: { root: place.root, path, type: 'file' }, creating: true })
          }}
        />
      )}
      {showResults && <SearchResults search={search} roots={roots} onPick={pick} />}
      <div className={showResults ? 'hidden' : 'contents'}>
        {open === null ? (
          <ListBody taskId={taskId} listing={listing} roots={roots} recent={place.root === RECENT} onOpen={openEntry} />
        ) : (
          <FileViewer
            key={`${open.target.root}:${open.target.path}`}
            taskId={taskId}
            file={open}
            writable={writableRoot(open.target.root)}
            dotfiles={dotfiles}
            onBack={() => void go(place, null)}
            onCreated={() => {
              setOpen({ ...open, creating: false })
            }}
          />
        )}
      </div>
    </section>
  )
}
