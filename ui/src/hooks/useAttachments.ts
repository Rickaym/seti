import type { AttachmentRef, StagedUpload, UploadSource } from '@seti/shared'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { apiDelete } from '@/api'
import {
  attachmentStore,
  fileAttachment,
  outgoing,
  pasteAttachment,
  stagedUrl,
  withInline,
  withoutToken,
  type DraftAttachment,
} from '@/lib/attachments'
import { sendUpload } from '@/lib/upload-request'
import type { UploadFailure, UploadState, UploadTotals } from '@/lib/upload-state'
import { NO_UPLOADS, Uploader, type UploadView } from '@/lib/uploader'

export interface Attachments {
  items: DraftAttachment[]
  /** Each file still on its way or failed, by item key; a file on the server has no entry. */
  uploads: ReadonlyMap<string, UploadState>
  /** Bytes sent of bytes to send over the files still uploading; null when none is. */
  overall: UploadTotals | null
  /** Why the draft cannot go out yet: a file still uploading, stalled or failed. */
  pending: string | null
  /** Adds pasted text as a file and returns the token to put in the draft. */
  addText: (text: string) => string
  addFiles: (files: readonly File[]) => string[]
  /** Drops the file and its token from the draft, and stops its upload. */
  drop: (key: string) => void
  /** Sends a stalled or failed file again. */
  retry: (key: string) => void
  /** Puts pasted text back into the draft in place of its token. */
  inline: (key: string) => Promise<void>
  /** What to send for the draft text, then forgets the files once the message went out. */
  message: (text: string) => { prompt: string; attachments?: AttachmentRef[] }
  sent: () => void
  /** Puts back uploaded files of a message that was taken back for editing. */
  restore: (files: readonly DraftAttachment[]) => void
}

const forget = (id: string) => {
  void apiDelete(`/uploads/${id}`).catch(() => undefined)
}

async function stagedText(item: DraftAttachment): Promise<string> {
  if (item.staged === null) {
    return ''
  }
  const res = await fetch(stagedUrl(item.staged.id))
  if (!res.ok) {
    throw new Error(`${item.name} is no longer on the server; drop it and paste it again`)
  }
  return res.text()
}

export const uploadingText = (count: number) => `Uploading ${String(count)} ${count === 1 ? 'file' : 'files'}...`

export function pendingOf(items: readonly DraftAttachment[], uploads: ReadonlyMap<string, UploadState>): string | null {
  for (const item of items) {
    const state = uploads.get(item.key)
    if (state?.phase === 'failed') {
      const way = state.failure.retry ? 'Retry or drop' : 'Drop'
      return `${item.name} did not upload: ${state.failure.reason}. ${way} it to send.`
    }
    if (state?.phase === 'stalled') {
      return `${item.name} stalled. Retry or drop it to send.`
    }
  }
  const uploading = items.filter((item) => item.staged === null).length
  return uploading === 0 ? null : uploadingText(uploading)
}

const failureToast = (key: string) => `upload-${key}`

const reportFailure = (key: string, name: string, failure: UploadFailure) => {
  toast.error(`${name} did not upload`, { id: failureToast(key), description: failure.reason, duration: Infinity })
}

const placed = (items: readonly DraftAttachment[], key: string, staged: StagedUpload): DraftAttachment[] => {
  const { kind, type, size, lines } = staged
  return items.map((item) => (item.key === key ? { ...item, staged, kind, type, size, lines } : item))
}

/** The files of the draft under `storeKey`, kept across reloads; null keeps them in view only. */
export function useAttachments(storeKey: string | null, draft: string, setDraft: (text: string) => void): Attachments {
  const [items, setItems] = useState(() => (storeKey === null ? [] : attachmentStore.read(storeKey)))
  const [view, setView] = useState<UploadView>(NO_UPLOADS)
  const [uploader] = useState(
    () =>
      new Uploader({
        send: sendUpload,
        onChange: setView,
        onDone: (key, staged) => {
          setItems((prev) => placed(prev, key, staged))
        },
        onFail: reportFailure,
      }),
  )

  useEffect(() => {
    if (storeKey !== null) {
      attachmentStore.write(storeKey, items)
    }
  }, [storeKey, items])

  useEffect(() => {
    uploader.resume()
    return () => {
      uploader.pause()
    }
  }, [uploader])

  const upload = (item: DraftAttachment, body: Blob, source: UploadSource) => {
    uploader.start(item.key, { name: item.name, body, source })
  }

  const addText = (text: string) => {
    const item = pasteAttachment(
      text,
      items.map((other) => other.name),
    )
    setItems((prev) => [...prev, item])
    upload(item, new Blob([text], { type: 'text/plain' }), 'paste')
    return item.token
  }

  const addFiles = (files: readonly File[]) => {
    const taken = items.map((other) => other.name)
    const added = files.map((file) => {
      const item = fileAttachment(file, taken)
      taken.push(item.name)
      upload(item, file, 'file')
      return item
    })
    setItems((prev) => [...prev, ...added])
    return added.map((item) => item.token)
  }

  const release = (item: DraftAttachment) => {
    uploader.cancel(item.key)
    toast.dismiss(failureToast(item.key))
    if (item.preview !== undefined) {
      URL.revokeObjectURL(item.preview)
    }
    setItems((prev) => prev.filter((other) => other.key !== item.key))
    if (item.staged !== null) {
      forget(item.staged.id)
    }
  }

  const drop = (key: string) => {
    const item = items.find((other) => other.key === key)
    if (item === undefined) {
      return
    }
    release(item)
    setDraft(withoutToken(draft, item.token))
  }

  const retry = (key: string) => {
    toast.dismiss(failureToast(key))
    uploader.retry(key)
  }

  const inline = async (key: string) => {
    const item = items.find((other) => other.key === key)
    if (item?.kind !== 'text') {
      return
    }
    const text = item.text ?? (await stagedText(item))
    release(item)
    setDraft(withInline(draft, item.token, text))
  }

  const sent = () => {
    for (const item of items) {
      if (item.preview !== undefined) {
        URL.revokeObjectURL(item.preview)
      }
    }
    setItems([])
  }

  const restore = (files: readonly DraftAttachment[]) => {
    setItems((prev) => [...prev, ...files.filter((file) => !prev.some((other) => other.key === file.key))])
  }

  return {
    items,
    uploads: view.states,
    overall: view.overall,
    pending: pendingOf(items, view.states),
    addText,
    addFiles,
    drop,
    retry,
    inline,
    message: (text) => outgoing(text, items),
    sent,
    restore,
  }
}
