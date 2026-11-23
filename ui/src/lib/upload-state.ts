import { ATTACHMENT_FILE_MAX, formatBytes } from '@seti/shared'
import { errorText, RequestError } from '@/api'

/** Why an upload ended without the file on the server. */
export interface UploadFailure {
  /** A word or two for the chip. */
  label: string
  /** The whole reason, for the tooltip, the toast and the line by the box. */
  reason: string
  /** Whether sending the same file again can work. */
  retry: boolean
}

/** One file on its way: sending, quiet for too long, or ended with a reason. */
export type UploadState =
  | { phase: 'uploading'; sent: number; total: number }
  | { phase: 'stalled'; sent: number; total: number }
  | { phase: 'failed'; failure: UploadFailure }

export type UploadEvent =
  { type: 'progress'; sent: number; total: number } | { type: 'stall' } | { type: 'fail'; failure: UploadFailure }

/** Bytes sent of bytes to send, over every file still on its way. */
export interface UploadTotals {
  sent: number
  total: number
}

export const started = (total: number): UploadState => ({ phase: 'uploading', sent: 0, total })

/** The next state: bytes moving end a stall, and only a new start leaves a failure. */
export function step(state: UploadState, event: UploadEvent): UploadState {
  if (state.phase === 'failed') {
    return state
  }
  switch (event.type) {
    case 'progress':
      return { phase: 'uploading', sent: Math.min(event.sent, event.total), total: event.total }
    case 'stall':
      return { ...state, phase: 'stalled' }
    case 'fail':
      return { phase: 'failed', failure: event.failure }
  }
}

/** Whole percent sent, reaching 100 only when every byte left. */
export const percentOf = ({ sent, total }: UploadTotals) => (total <= 0 ? 0 : Math.floor((sent / total) * 100))

export const sentOf = ({ sent, total }: UploadTotals) => `${formatBytes(sent)} of ${formatBytes(total)} sent`

const LIMIT = formatBytes(ATTACHMENT_FILE_MAX)

/** The refusal for a file over the limit, known before a byte is sent. */
export function tooLarge(name: string, size: number): UploadFailure | null {
  if (size <= ATTACHMENT_FILE_MAX) {
    return null
  }
  return {
    label: 'Too large',
    reason: `${name} is ${formatBytes(size)} and one file can be at most ${LIMIT}`,
    retry: false,
  }
}

const GATEWAY_STATUSES: readonly number[] = [502, 503, 504]

/** What a status means when the answer did not come from Seti itself. */
function proxyFailure(status: number): UploadFailure | null {
  if (status === 413) {
    return {
      label: 'Too large',
      reason: `A proxy in front of Seti refused the file as too large; Seti takes ${LIMIT} a file`,
      retry: false,
    }
  }
  if (status === 408) {
    return { label: 'Timed out', reason: 'The upload took longer than the server allows', retry: true }
  }
  return GATEWAY_STATUSES.includes(status)
    ? { label: 'Unreachable', reason: 'Seti could not be reached', retry: true }
    : null
}

/** Reads a rejected upload as a reason a person can act on. */
export function failureOf(e: unknown): UploadFailure {
  if (!(e instanceof RequestError)) {
    return { label: 'Failed', reason: errorText(e), retry: true }
  }
  if (e.status === 0) {
    return { label: 'Connection lost', reason: 'The connection to Seti dropped before the file arrived', retry: true }
  }
  if (e.status === 401) {
    return { label: 'Signed out', reason: 'Sign in again, then retry', retry: true }
  }
  const proxy = e.body === null ? proxyFailure(e.status) : null
  if (proxy !== null) {
    return proxy
  }
  if (e.status === 413) {
    return { label: 'Too large', reason: e.message, retry: false }
  }
  if (e.status === 408) {
    return { label: 'Timed out', reason: e.message, retry: true }
  }
  return { label: 'Refused', reason: e.message, retry: e.status >= 500 }
}
