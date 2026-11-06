import { filesLinkHash, type FileEntryType } from '@seti/shared'
import { streamUrl } from '@/api'

/** A file or folder the Files view opens, in one of the task's roots. */
export interface FileTarget {
  root: string
  path: string
  type: FileEntryType
  /** Set for a file in another task's workspace, which opens in that task's Files view. */
  task_id?: string | undefined
}

type Params = Record<string, string | boolean | undefined>

/** The API path of a files endpoint with its query; false and undefined values are left out. */
export function filesPath(taskId: string, endpoint: string, params: Params = {}): string {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === true) {
      query.set(key, '1')
    } else if (typeof value === 'string') {
      query.set(key, value)
    }
  }
  const text = query.toString()
  const base = `/tasks/${taskId}/files/${endpoint}`
  return text === '' ? base : `${base}?${text}`
}

export interface RawOptions {
  dotfiles: boolean
  download?: boolean
  /** An html file as a sandboxed page, for the viewer's frame. */
  preview?: boolean
  /** Changes with the file, so the browser never shows a stale copy. */
  version?: string | undefined
}

export const rawUrl = (taskId: string, target: Pick<FileTarget, 'root' | 'path'>, options: RawOptions) =>
  streamUrl(
    filesPath(taskId, 'raw', {
      root: target.root,
      path: target.path,
      dotfiles: options.dotfiles,
      download: options.download,
      preview: options.preview,
      v: options.version,
    }),
  )

/** A file's raw bytes from `rawUrl`, failing with the server's reason when it refuses. */
export async function fetchRaw(url: string, signal: AbortSignal): Promise<Response> {
  const res = await fetch(url, { signal })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { detail?: string } } | null
    throw new Error(body?.error?.detail ?? `Could not load the file (${String(res.status)})`)
  }
  return res
}

export const parentOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')

export const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1)

/** The address that opens this file or folder in the task's Files view, for Copy link. */
export const filesLinkUrl = (taskId: string, target: Pick<FileTarget, 'root' | 'path' | 'type'>) =>
  `${window.location.origin}/#${filesLinkHash({ task_id: taskId, ...target })}`
