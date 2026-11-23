import { ATTACHMENT_FILE_MAX } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { RequestError } from '@/api'
import { failureOf, percentOf, sentOf, started, step, tooLarge, type UploadState } from '@/lib/upload-state'

const MB = 1024 * 1024
const lost = { label: 'Connection lost', reason: 'gone', retry: true }

describe('step', () => {
  it('moves with the bytes, and never past the total', () => {
    const half = step(started(10 * MB), { type: 'progress', sent: 4 * MB, total: 10 * MB })
    expect(half).toEqual({ phase: 'uploading', sent: 4 * MB, total: 10 * MB })
    expect(step(half, { type: 'progress', sent: 11 * MB, total: 10 * MB })).toMatchObject({ sent: 10 * MB })
  })

  it('stalls where it stopped and goes on when bytes move again', () => {
    const at: UploadState = { phase: 'uploading', sent: 3, total: 10 }
    const stalled = step(at, { type: 'stall' })
    expect(stalled).toEqual({ phase: 'stalled', sent: 3, total: 10 })
    expect(step(stalled, { type: 'progress', sent: 5, total: 10 })).toEqual({ phase: 'uploading', sent: 5, total: 10 })
  })

  it('fails from uploading or stalled, and a failure stays until a new start', () => {
    const failed = step(step(started(10), { type: 'stall' }), { type: 'fail', failure: lost })
    expect(failed).toEqual({ phase: 'failed', failure: lost })
    expect(step(failed, { type: 'progress', sent: 5, total: 10 })).toBe(failed)
    expect(step(failed, { type: 'stall' })).toBe(failed)
  })
})

describe('percentOf and sentOf', () => {
  it('rounds down, so 100 means every byte left', () => {
    expect(percentOf({ sent: 0, total: 0 })).toBe(0)
    expect(percentOf({ sent: 4 * MB, total: 10 * MB })).toBe(40)
    expect(percentOf({ sent: 999, total: 1000 })).toBe(99)
    expect(percentOf({ sent: 1000, total: 1000 })).toBe(100)
    expect(sentOf({ sent: 4 * MB, total: 10 * MB })).toBe('4.0 MB of 10 MB sent')
  })
})

describe('tooLarge', () => {
  it('refuses a file over the limit with its size and the limit', () => {
    expect(tooLarge('ok.bin', ATTACHMENT_FILE_MAX)).toBeNull()
    expect(tooLarge('big.zip', 40 * MB)).toEqual({
      label: 'Too large',
      reason: 'big.zip is 40 MB and one file can be at most 25 MB',
      retry: false,
    })
  })
})

describe('failureOf', () => {
  const fromSeti = (status: number, detail: string) => new RequestError(status, detail, { error: { detail } })

  it('says the connection dropped when no answer came', () => {
    expect(failureOf(new RequestError(0, 'The connection dropped'))).toMatchObject({
      label: 'Connection lost',
      retry: true,
    })
  })

  it("keeps Seti's own reason for a refusal, and offers no retry for one that cannot work", () => {
    const limit = 'huge.bin is over the 25 MB limit for one file'
    expect(failureOf(fromSeti(413, limit))).toEqual({ label: 'Too large', reason: limit, retry: false })
    expect(failureOf(fromSeti(400, 'empty.txt is empty'))).toEqual({
      label: 'Refused',
      reason: 'empty.txt is empty',
      retry: false,
    })
    expect(failureOf(fromSeti(408, 'a.bin stopped arriving; send it again'))).toMatchObject({
      label: 'Timed out',
      retry: true,
    })
    expect(failureOf(fromSeti(500, 'Disk full'))).toMatchObject({ label: 'Refused', retry: true })
  })

  it('names the proxy when the answer is not from Seti', () => {
    expect(failureOf(new RequestError(413, 'Upload failed (413)'))).toEqual({
      label: 'Too large',
      reason: 'A proxy in front of Seti refused the file as too large; Seti takes 25 MB a file',
      retry: false,
    })
    expect(failureOf(new RequestError(408, 'Upload failed (408)'))).toMatchObject({ label: 'Timed out', retry: true })
    expect(failureOf(new RequestError(502, 'Upload failed (502)'))).toMatchObject({ label: 'Unreachable', retry: true })
    expect(failureOf(new RequestError(418, 'Upload failed (418)'))).toMatchObject({
      label: 'Refused',
      reason: 'Upload failed (418)',
    })
  })

  it('asks for a sign-in on 401 and reads any other error as it is', () => {
    expect(failureOf(new RequestError(401, 'Sign in'))).toMatchObject({ label: 'Signed out', retry: true })
    expect(failureOf(new Error('boom'))).toEqual({ label: 'Failed', reason: 'boom', retry: true })
  })
})
