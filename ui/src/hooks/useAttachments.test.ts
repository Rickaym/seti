import { describe, expect, it } from 'vitest'
import { pendingOf } from '@/hooks/useAttachments'
import type { DraftAttachment } from '@/lib/attachments'
import type { UploadState } from '@/lib/upload-state'

const item = (name: string, uploaded: boolean): DraftAttachment => ({
  key: name,
  token: `[${name}]`,
  name,
  kind: 'file',
  type: 'PDF',
  size: 100,
  lines: null,
  staged: uploaded
    ? {
        id: name,
        name,
        source: 'file',
        kind: 'file',
        type: 'PDF',
        mime: 'application/pdf',
        size: 100,
        lines: null,
        shown: false,
      }
    : null,
})

const uploading: UploadState = { phase: 'uploading', sent: 40, total: 100 }

describe('pendingOf', () => {
  it('lets the draft go once every file is on the server', () => {
    expect(pendingOf([], new Map())).toBeNull()
    expect(pendingOf([item('a.pdf', true)], new Map())).toBeNull()
  })

  it('counts the files still uploading', () => {
    const items = [item('a.pdf', false), item('b.pdf', false), item('c.pdf', true)]
    expect(pendingOf(items.slice(1), new Map([['b.pdf', uploading]]))).toBe('Uploading 1 file...')
    expect(pendingOf(items, new Map([['a.pdf', uploading]]))).toBe('Uploading 2 files...')
  })

  it('names a stalled file and a failed one with its reason, and what ends the wait', () => {
    const items = [item('a.pdf', false), item('b.pdf', false)]
    const stalled = new Map<string, UploadState>([
      ['a.pdf', uploading],
      ['b.pdf', { phase: 'stalled', sent: 10, total: 100 }],
    ])
    expect(pendingOf(items, stalled)).toBe('b.pdf stalled. Retry or drop it to send.')
    const failed = (retry: boolean) =>
      new Map<string, UploadState>([
        ['a.pdf', { phase: 'failed', failure: { label: 'Too large', reason: 'a.pdf is over the limit', retry } }],
      ])
    expect(pendingOf(items, failed(false))).toBe('a.pdf did not upload: a.pdf is over the limit. Drop it to send.')
    expect(pendingOf(items, failed(true))).toBe(
      'a.pdf did not upload: a.pdf is over the limit. Retry or drop it to send.',
    )
  })
})
