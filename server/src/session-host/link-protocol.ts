import { NODE_PROTOCOL_RANGE } from '@seti/shared'
import type { LocalProtocol } from '../node-link/handshake.js'

/** What this build speaks on the link between Seti and its session process. */
export const NODE_LINK_PROTOCOL: LocalProtocol = { protocol: NODE_PROTOCOL_RANGE, features: [] }
