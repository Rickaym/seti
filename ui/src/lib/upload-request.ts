import type { StagedUpload, UploadSource } from '@seti/shared'
import { RequestError, SIGN_IN_REQUIRED, streamUrl } from '@/api'

export interface UploadRequest {
  name: string
  body: Blob
  source: UploadSource
}

/** Sends one file, reports bytes as they leave, and rejects with a `RequestError`. */
export type SendUpload = (
  request: UploadRequest,
  onProgress: (sent: number, total: number) => void,
  signal: AbortSignal,
) => Promise<StagedUpload>

interface UploadEnvelope {
  data?: StagedUpload
  error?: { detail: string }
}

function envelopeOf(text: string): UploadEnvelope | null {
  try {
    return JSON.parse(text) as UploadEnvelope | null
  } catch {
    return null
  }
}

function answer(xhr: XMLHttpRequest): StagedUpload {
  if (xhr.status === 401) {
    window.dispatchEvent(new Event(SIGN_IN_REQUIRED))
  }
  const envelope = envelopeOf(xhr.responseText)
  const ok = xhr.status >= 200 && xhr.status < 300
  if (!ok || envelope?.data === undefined) {
    const detail = envelope?.error?.detail ?? `Upload failed (${String(xhr.status)})`
    throw new RequestError(xhr.status, detail, envelope?.error === undefined ? null : envelope)
  }
  return envelope.data
}

/** The file as the request body, which the server sniffs and stages; fetch reports no progress. */
export const sendUpload: SendUpload = async ({ name, body, source }, onProgress, signal) =>
  new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const query = new URLSearchParams({ name, source })
    xhr.open('POST', streamUrl(`/uploads?${query.toString()}`))
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    xhr.upload.onprogress = (e) => {
      onProgress(e.loaded, e.lengthComputable ? e.total : body.size)
    }
    xhr.onload = () => {
      try {
        resolve(answer(xhr))
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    }
    xhr.onerror = () => {
      reject(new RequestError(0, 'The connection dropped'))
    }
    signal.addEventListener(
      'abort',
      () => {
        xhr.abort()
        reject(new DOMException('The upload was cancelled', 'AbortError'))
      },
      { once: true },
    )
    xhr.send(body)
  })
