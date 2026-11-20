import type { Writable } from 'node:stream'

/** Asks, commands and replies go first, journal batches second, bulk bytes last. */
export type Lane = 'control' | 'journal' | 'bulk'

const ORDER: readonly Lane[] = ['control', 'journal', 'bulk']

/** Writes encoded frames in lane order, holding them while the stream is full. */
export class Outbox {
  private readonly lanes: Record<Lane, Buffer[]> = { control: [], journal: [], bulk: [] }
  private readonly writable: Writable
  private waiting = false
  private ending = false

  constructor(writable: Writable) {
    this.writable = writable
  }

  push(lane: Lane, frame: Buffer): void {
    if (this.ending || this.writable.destroyed) {
      return
    }
    this.lanes[lane].push(frame)
    this.pump()
  }

  /** Ends the stream once every queued frame is written. */
  end(): void {
    this.ending = true
    this.pump()
  }

  private next(): Buffer | undefined {
    for (const lane of ORDER) {
      const frame = this.lanes[lane].shift()
      if (frame !== undefined) {
        return frame
      }
    }
    return undefined
  }

  private pump(): void {
    while (!this.waiting && !this.writable.destroyed) {
      const frame = this.next()
      if (frame === undefined) {
        if (this.ending && !this.writable.writableEnded) {
          this.writable.end()
        }
        return
      }
      if (!this.writable.write(frame)) {
        this.waiting = true
        this.writable.once('drain', () => {
          this.waiting = false
          this.pump()
        })
      }
    }
  }
}
