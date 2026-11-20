import type { NodeMessage, NodeMessageOf, NodeMessageType } from '@seti/shared'
import type { CloseReason } from './connection.js'

/** What a link reports to its owner for logs and the node's status. */
export type LinkEvent =
  | { type: 'connected'; node: string; version: number }
  | { type: 'disconnected'; reason: CloseReason }
  | { type: 'incompatible'; node: string }
  | { type: 'journal-stopped'; agent: string; reason: string }
  | { type: 'journal-error'; message: string }
  | { type: 'unsupported'; messageType: string }

export type LinkEventSink = (event: LinkEvent) => void

/** A handler for each message type, so dispatch needs no switch over every type. */
export type MessageRoutes = { [K in NodeMessageType]: (message: NodeMessageOf<K>) => void }

/** Calls the route for `message`'s type. */
export function route(routes: MessageRoutes, message: NodeMessage): void {
  const handler = routes[message.type] as (message: NodeMessage) => void
  handler(message)
}
