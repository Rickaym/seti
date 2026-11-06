import type { AttachmentRef } from '@seti/shared'
import { useCallback, useEffect, useRef, useState } from 'react'
import { apiDelete, errorText } from '@/api'
import {
  attachmentStore,
  fileAttachment,
  outgoing,
  pasteAttachment,
  stagedUrl,
  uploadFile,
  withInline,
  withoutToken,
  type DraftAttachment,
} from '@/lib/attachments'

export interface Attachments {
  items: DraftAttachment[]
  /** Why each failed upload failed, by item key. */
  failed: ReadonlyMap<string, string>
  /** Why the draft cannot go out yet: a file still uploading or one that failed. */
  pending: string | null
  /** Adds pasted text as a file and returns the token to put in the draft. */
  addText: (text: string) => string
  addFiles: (files: readonly File[]) => string[]
  /** Drops the file and its token from the draft. */
  drop: (key: string) => void
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

function pendingOf(items: readonly DraftAttachment[], failed: ReadonlyMap<string, string>): string | null {
  const broken = items.find((item) => failed.has(item.key))
  if (broken !== undefined) {
    return `${broken.name} did not upload: ${failed.get(broken.key) ?? ''}. Drop it to send.`
  }
  const uploading = items.filter((item) => item.staged === null).length
  const noun = uploading === 1 ? 'file' : 'files'
  return uploading === 0 ? null : `Uploading ${String(uploading)} ${noun}...`
}

/** The files of the draft under `storeKey`, kept across reloads; null keeps them in view only. */
export function useAttachments(storeKey: string | null, draft: string, setDraft: (text: string) => void): Attachments {
  const [items, setItems] = useState(() => (storeKey === null ? [] : attachmentStore.read(storeKey)))
  const [failed, setFailed] = useState<ReadonlyMap<string, string>>(new Map())
  const dropped = useRef(new Set<string>())

  useEffect(() => {
    if (storeKey !== null) {
      attachmentStore.write(storeKey, items)
    }
  }, [storeKey, items])

  const upload = useCallback((item: DraftAttachment, body: Blob, source: 'paste' | 'file') => {
    uploadFile(body, item.name, source)
      .then((staged) => {
        if (dropped.current.has(item.key)) {
          forget(staged.id)
          return
        }
        const { kind, type, size, lines } = staged
        setItems((prev) =>
          prev.map((other) => (other.key === item.key ? { ...other, staged, kind, type, size, lines } : other)),
        )
      })
      .catch((e: unknown) => {
        setFailed((prev) => new Map(prev).set(item.key, errorText(e)))
      })
  }, [])

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
    dropped.current.add(item.key)
    if (item.preview !== undefined) {
      URL.revokeObjectURL(item.preview)
    }
    setItems((prev) => prev.filter((other) => other.key !== item.key))
    setFailed((prev) => {
      const next = new Map(prev)
      next.delete(item.key)
      return next
    })
  }

  const drop = (key: string) => {
    const item = items.find((other) => other.key === key)
    if (item === undefined) {
      return
    }
    release(item)
    if (item.staged !== null) {
      forget(item.staged.id)
    }
    setDraft(withoutToken(draft, item.token))
  }

  const inline = async (key: string) => {
    const item = items.find((other) => other.key === key)
    if (item?.kind !== 'text') {
      return
    }
    const text = item.text ?? (await stagedText(item))
    release(item)
    if (item.staged !== null) {
      forget(item.staged.id)
    }
    setDraft(withInline(draft, item.token, text))
  }

  const sent = () => {
    for (const item of items) {
      dropped.current.add(item.key)
      if (item.preview !== undefined) {
        URL.revokeObjectURL(item.preview)
      }
    }
    setItems([])
    setFailed(new Map())
  }

  const restore = (files: readonly DraftAttachment[]) => {
    for (const file of files) {
      dropped.current.delete(file.key)
    }
    setItems((prev) => [...prev, ...files.filter((file) => !prev.some((other) => other.key === file.key))])
  }

  return {
    items,
    failed,
    pending: pendingOf(items, failed),
    addText,
    addFiles,
    drop,
    inline,
    message: (text) => outgoing(text, items),
    sent,
    restore,
  }
}
