import type { FileNameHit, FileSearch, FileSearchMode, FileTextHit } from '@seti/shared'
import { useEffect, useState } from 'react'
import { apiGet, errorText } from '@/api'
import { filesPath, type FileTarget } from '@/panels/files/files-api'

const DEBOUNCE_MS = 200

/** A file or folder a search result opens, at a line for a text match. */
export type SearchPick = FileTarget & { line?: number }

export const pickOf = (hit: FileNameHit | FileTextHit): SearchPick =>
  'line' in hit
    ? { root: hit.root, path: hit.path, type: 'file', line: hit.line }
    : { root: hit.root, path: hit.path, type: hit.type }

/** The first result of a search, for Enter in the field. */
export const firstPick = (result: FileSearch | null): SearchPick | null => {
  const hit = result?.hits[0]
  return hit === undefined ? null : pickOf(hit)
}

export interface FileSearchState {
  query: string
  mode: FileSearchMode
  regex: boolean
  /** The latest answer, kept on screen while a newer query runs. */
  result: FileSearch | null
  error: string | null
  /** A query waits for its answer. */
  searching: boolean
  setQuery: (query: string) => void
  setMode: (mode: FileSearchMode) => void
  setRegex: (regex: boolean) => void
}

interface Answer {
  key: string
  result: FileSearch | null
  error: string | null
}

/** What a search takes in besides its query: dot files, and the files Seti writes. */
interface SearchScope {
  dotfiles: boolean
  setiFiles: boolean
}

/** Debounced search of a task's files; a newer query cancels the request of the one before. */
export function useFileSearch(taskId: string, { dotfiles, setiFiles }: SearchScope): FileSearchState {
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<FileSearchMode>('name')
  const [regex, setRegex] = useState(false)
  const [answer, setAnswer] = useState<Answer | null>(null)
  const q = query.trim()
  const asRegex = mode === 'text' && regex
  const key = q === '' ? null : JSON.stringify([taskId, q, mode, asRegex, dotfiles, setiFiles])

  useEffect(() => {
    if (key === null) {
      return undefined
    }
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      const path = filesPath(taskId, 'search', { q, mode, regex: asRegex, dotfiles, seti_files: setiFiles })
      apiGet<FileSearch>(path, controller.signal).then(
        (result) => {
          setAnswer({ key, result, error: null })
        },
        (e: unknown) => {
          if (!controller.signal.aborted) {
            setAnswer({ key, result: null, error: errorText(e) })
          }
        },
      )
    }, DEBOUNCE_MS)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [key, taskId, q, mode, asRegex, dotfiles, setiFiles])

  const current = key !== null && answer?.key === key
  return {
    query,
    mode,
    regex,
    result: key === null ? null : (answer?.result ?? null),
    error: current ? answer.error : null,
    searching: key !== null && !current,
    setQuery,
    setMode,
    setRegex,
  }
}
