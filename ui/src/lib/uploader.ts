import { UPLOAD_STALL_MS, type StagedUpload } from '@seti/shared'
import type { SendUpload, UploadRequest } from '@/lib/upload-request'
import {
  failureOf,
  started,
  step,
  tooLarge,
  type UploadEvent,
  type UploadFailure,
  type UploadState,
  type UploadTotals,
} from '@/lib/upload-state'

/** Every upload not yet on the server, by key, and their bytes together; null when none moves. */
export interface UploadView {
  states: ReadonlyMap<string, UploadState>
  overall: UploadTotals | null
}

export const NO_UPLOADS: UploadView = { states: new Map(), overall: null }

interface UploaderHooks {
  send: SendUpload
  onChange: (view: UploadView) => void
  onDone: (key: string, staged: StagedUpload) => void
  onFail: (key: string, name: string, failure: UploadFailure) => void
  stallMs?: number
}

/** One file's upload: its request in flight, its state and the watch for a stall. */
class Transfer {
  readonly request: UploadRequest
  state: UploadState
  paused = false
  private flight: AbortController | null = null
  private quiet?: ReturnType<typeof setTimeout>

  constructor(request: UploadRequest) {
    this.request = request
    this.state = started(request.body.size)
  }

  get flying(): boolean {
    return this.flight !== null
  }

  /** Starts over with a new request in flight, which tells its answers from an older one's. */
  take(): AbortController {
    this.paused = false
    this.state = started(this.request.body.size)
    this.flight = new AbortController()
    return this.flight
  }

  owns(flight: AbortController): boolean {
    return this.flight === flight
  }

  apply(event: UploadEvent): void {
    this.state = step(this.state, event)
  }

  refuse(failure: UploadFailure): void {
    this.paused = false
    this.state = { phase: 'failed', failure }
  }

  /** Restarts the wait for the next byte. */
  watch(ms: number, onQuiet: () => void): void {
    clearTimeout(this.quiet)
    this.quiet = setTimeout(onQuiet, ms)
  }

  /** Stops watching a request that ended by itself. */
  landed(): void {
    clearTimeout(this.quiet)
    this.flight = null
  }

  /** Stops the request in flight. */
  halt(): void {
    this.flight?.abort()
    this.landed()
  }
}

/** Runs a draft's uploads: progress, a stall when bytes stop, a reason on failure, retry, cancel. */
export class Uploader {
  private readonly entries = new Map<string, Transfer>()
  private readonly hooks: UploaderHooks
  /** Bytes of files that finished while others still move, so the overall bar never runs back. */
  private finished = 0

  constructor(hooks: UploaderHooks) {
    this.hooks = hooks
  }

  start(key: string, request: UploadRequest): void {
    const entry = new Transfer(request)
    this.entries.set(key, entry)
    this.run(key, entry)
  }

  /** Sends a stalled or failed file again from its first byte. */
  retry(key: string): void {
    const entry = this.entries.get(key)
    if (entry !== undefined) {
      entry.halt()
      this.run(key, entry)
    }
  }

  /** Stops the upload and forgets the file. */
  cancel(key: string): void {
    const entry = this.entries.get(key)
    if (entry !== undefined) {
      entry.halt()
      this.entries.delete(key)
      this.publish()
    }
  }

  /** Stops every request in flight when the view goes away; `resume` sends them again. */
  pause(): void {
    for (const entry of this.entries.values()) {
      if (entry.flying) {
        entry.halt()
        entry.paused = true
      }
    }
  }

  resume(): void {
    for (const [key, entry] of this.entries) {
      if (entry.paused) {
        this.run(key, entry)
      }
    }
  }

  private run(key: string, entry: Transfer): void {
    const { name, body } = entry.request
    const refused = tooLarge(name, body.size)
    if (refused !== null) {
      entry.refuse(refused)
      this.publish()
      this.hooks.onFail(key, name, refused)
      return
    }
    const flight = entry.take()
    this.watch(entry, flight)
    this.publish()
    this.hooks
      .send(
        entry.request,
        (sent, total) => {
          if (entry.owns(flight)) {
            entry.apply({ type: 'progress', sent, total })
            this.watch(entry, flight)
            this.publish()
          }
        },
        flight.signal,
      )
      .then((staged) => {
        if (entry.owns(flight)) {
          entry.landed()
          this.entries.delete(key)
          this.finished += body.size
          this.hooks.onDone(key, staged)
          this.publish()
        }
      })
      .catch((e: unknown) => {
        if (entry.owns(flight)) {
          const failure = failureOf(e)
          entry.landed()
          entry.apply({ type: 'fail', failure })
          this.publish()
          this.hooks.onFail(key, name, failure)
        }
      })
  }

  /** Calls the upload stalled when no byte moves for the stall time; it stays in flight. */
  private watch(entry: Transfer, flight: AbortController): void {
    entry.watch(this.hooks.stallMs ?? UPLOAD_STALL_MS, () => {
      if (entry.owns(flight)) {
        entry.apply({ type: 'stall' })
        this.publish()
      }
    })
  }

  private publish(): void {
    const states = new Map<string, UploadState>()
    let sent = this.finished
    let total = this.finished
    let live = 0
    for (const [key, entry] of this.entries) {
      states.set(key, entry.state)
      if (entry.state.phase !== 'failed') {
        sent += entry.state.sent
        total += entry.state.total
        live += 1
      }
    }
    if (live === 0) {
      this.finished = 0
    }
    this.hooks.onChange({ states, overall: live === 0 ? null : { sent, total } })
  }
}
