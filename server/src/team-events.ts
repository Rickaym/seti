import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { TeamStreamEvent } from '@seti/shared'
import { broadcast, listen } from './redis.js'

const bus = new EventEmitter()
bus.setMaxListeners(0)

const ORIGIN = randomUUID()
const CHANNEL = 'team'
const EVENT = 'event'

interface Relayed {
  origin: string
  event: TeamStreamEvent
}

export function subscribeTeam(listener: (event: TeamStreamEvent) => void): () => void {
  bus.on(EVENT, listener)
  return () => bus.off(EVENT, listener)
}

/** Delivers to this process's team streams at once and to other processes' through Redis. */
export function publishTeam(event: TeamStreamEvent): void {
  bus.emit(EVENT, event)
  void broadcast(CHANNEL, JSON.stringify({ origin: ORIGIN, event } satisfies Relayed))
}

/** Hands team events that other processes publish to this process's streams. */
export function relayTeamEvents(): void {
  listen(CHANNEL, (_channel, message) => {
    const relayed = JSON.parse(message) as Relayed
    if (relayed.origin !== ORIGIN) {
      bus.emit(EVENT, relayed.event)
    }
  })
}
