import { ATTACHMENT_FILE_MAX, type StagedUpload } from '@seti/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RequestError } from '@/api'
import type { SendUpload, UploadRequest } from '@/lib/upload-request'
import type { UploadFailure } from '@/lib/upload-state'
import { NO_UPLOADS, Uploader, type UploadView } from '@/lib/uploader'

const STALL_MS = 1000

const staged = (name: string): StagedUpload => ({
  id: `id-${name}`,
  name,
  source: 'file',
  kind: 'file',
  type: 'PDF',
  mime: 'application/pdf',
  size: 100,
  lines: null,
  shown: false,
})

/** A request the test answers by hand, as the network would. */
interface Flight {
  request: UploadRequest
  progress: (sent: number) => void
  resolve: (staged: StagedUpload) => void
  reject: (e: unknown) => void
  signal: AbortSignal
}

function harness() {
  const flights: Flight[] = []
  const done: string[] = []
  const failed: { key: string; name: string; failure: UploadFailure }[] = []
  let view: UploadView = NO_UPLOADS
  const send: SendUpload = async (request, onProgress, signal) =>
    new Promise((resolve, reject) => {
      const progress = (sent: number) => {
        onProgress(sent, request.body.size)
      }
      flights.push({ request, progress, resolve, reject, signal })
    })
  const uploader = new Uploader({
    send,
    stallMs: STALL_MS,
    onChange: (next) => {
      view = next
    },
    onDone: (key) => done.push(key),
    onFail: (key, name, failure) => failed.push({ key, name, failure }),
  })
  const flight = (n: number): Flight => {
    const found = flights[n]
    if (found === undefined) {
      throw new Error(`no request ${String(n)}`)
    }
    return found
  }
  return { uploader, flights, flight, done, failed, state: (key: string) => view.states.get(key), view: () => view }
}

const file = (name: string, size = 100): UploadRequest => ({
  name,
  source: 'file',
  body: new Blob([new Uint8Array(size)]),
})

const settle = async () => vi.advanceTimersByTimeAsync(0)

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('Uploader', () => {
  it('reports bytes as they leave and forgets the file once it is on the server', async () => {
    const h = harness()
    h.uploader.start('a', file('a.pdf'))
    expect(h.state('a')).toEqual({ phase: 'uploading', sent: 0, total: 100 })
    h.flight(0).progress(40)
    expect(h.state('a')).toEqual({ phase: 'uploading', sent: 40, total: 100 })
    expect(h.view().overall).toEqual({ sent: 40, total: 100 })
    h.flight(0).resolve(staged('a.pdf'))
    await settle()
    expect(h.done).toEqual(['a'])
    expect(h.view()).toEqual(NO_UPLOADS)
  })

  it('calls an upload stalled when no byte moves for the stall time, and takes it back when one does', () => {
    const h = harness()
    h.uploader.start('a', file('a.pdf'))
    h.flight(0).progress(20)
    vi.advanceTimersByTime(STALL_MS - 1)
    expect(h.state('a')?.phase).toBe('uploading')
    h.flight(0).progress(30)
    vi.advanceTimersByTime(STALL_MS - 1)
    expect(h.state('a')?.phase).toBe('uploading')
    vi.advanceTimersByTime(1)
    expect(h.state('a')).toEqual({ phase: 'stalled', sent: 30, total: 100 })
    expect(h.flight(0).signal.aborted).toBe(false)
    h.flight(0).progress(50)
    expect(h.state('a')).toEqual({ phase: 'uploading', sent: 50, total: 100 })
  })

  it('stalls an upload whose bytes all left but which gets no answer', () => {
    const h = harness()
    h.uploader.start('a', file('a.pdf'))
    h.flight(0).progress(100)
    vi.advanceTimersByTime(STALL_MS)
    expect(h.state('a')).toEqual({ phase: 'stalled', sent: 100, total: 100 })
  })

  it('retries a stalled upload from the start and ignores the request it gave up', async () => {
    const h = harness()
    h.uploader.start('a', file('a.pdf'))
    h.flight(0).progress(20)
    vi.advanceTimersByTime(STALL_MS)
    h.uploader.retry('a')
    expect(h.flight(0).signal.aborted).toBe(true)
    expect(h.state('a')).toEqual({ phase: 'uploading', sent: 0, total: 100 })
    h.flight(0).progress(90)
    h.flight(0).reject(new RequestError(0, 'dropped'))
    await settle()
    expect(h.state('a')).toEqual({ phase: 'uploading', sent: 0, total: 100 })
    expect(h.failed).toEqual([])
    h.flight(1).resolve(staged('a.pdf'))
    await settle()
    expect(h.done).toEqual(['a'])
  })

  it('ends a failed upload with its reason, stops watching it, and sends it again on retry', async () => {
    const h = harness()
    h.uploader.start('a', file('a.pdf'))
    h.flight(0).progress(10)
    h.flight(0).reject(new RequestError(0, 'dropped'))
    await settle()
    expect(h.state('a')).toMatchObject({ phase: 'failed', failure: { label: 'Connection lost', retry: true } })
    expect(h.failed).toMatchObject([{ key: 'a', name: 'a.pdf', failure: { label: 'Connection lost' } }])
    expect(h.view().overall).toBeNull()
    vi.advanceTimersByTime(STALL_MS * 2)
    expect(h.state('a')?.phase).toBe('failed')
    h.uploader.retry('a')
    expect(h.state('a')).toEqual({ phase: 'uploading', sent: 0, total: 100 })
    h.flight(1).resolve(staged('a.pdf'))
    await settle()
    expect(h.done).toEqual(['a'])
  })

  it('refuses a file over the limit before sending a byte', () => {
    const h = harness()
    h.uploader.start('big', file('big.zip', 40 * 1024 * 1024))
    expect(h.flights).toHaveLength(0)
    expect(h.state('big')).toMatchObject({ phase: 'failed', failure: { label: 'Too large', retry: false } })
    expect(h.failed.map((each) => each.failure.reason)).toEqual(['big.zip is 40 MB and one file can be at most 25 MB'])
  })

  it('cancels an upload in flight: the request stops and a late answer changes nothing', async () => {
    const h = harness()
    h.uploader.start('a', file('a.pdf'))
    h.flight(0).progress(40)
    h.uploader.cancel('a')
    expect(h.flight(0).signal.aborted).toBe(true)
    expect(h.view()).toEqual(NO_UPLOADS)
    h.flight(0).resolve(staged('a.pdf'))
    await settle()
    vi.advanceTimersByTime(STALL_MS * 2)
    expect(h.done).toEqual([])
    expect(h.view()).toEqual(NO_UPLOADS)
  })

  it('keeps the overall bar from running back when one of several files finishes', async () => {
    const h = harness()
    h.uploader.start('a', file('a.pdf', 100))
    h.uploader.start('b', file('b.pdf', 300))
    h.flight(0).progress(100)
    h.flight(1).progress(60)
    expect(h.view().overall).toEqual({ sent: 160, total: 400 })
    h.flight(0).resolve(staged('a.pdf'))
    await settle()
    expect(h.view().overall).toEqual({ sent: 160, total: 400 })
    h.flight(1).resolve(staged('b.pdf'))
    await settle()
    expect(h.view().overall).toBeNull()
    h.uploader.start('c', file('c.pdf', 50))
    expect(h.view().overall).toEqual({ sent: 0, total: 50 })
  })

  it('stops requests in flight when the view goes away and sends them again when it is back', () => {
    const h = harness()
    h.uploader.start('a', file('a.pdf'))
    h.uploader.start('big', file('big.zip', ATTACHMENT_FILE_MAX + 1))
    h.uploader.pause()
    expect(h.flight(0).signal.aborted).toBe(true)
    vi.advanceTimersByTime(STALL_MS * 2)
    expect(h.state('a')?.phase).toBe('uploading')
    h.uploader.resume()
    expect(h.flights).toHaveLength(2)
    expect(h.flight(1).request.name).toBe('a.pdf')
    h.uploader.resume()
    expect(h.flights).toHaveLength(2)
  })
})
