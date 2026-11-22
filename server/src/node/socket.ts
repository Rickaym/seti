import fs from 'node:fs'
import path from 'node:path'

type StatOf = (file: string) => Pick<fs.Stats, 'uid' | 'mode'>

/** Only the owner may enter the socket's folder, or connect to the socket. */
const OWNER_ONLY = 0o077

/**
 * Refuses a node socket that another user made or could reach. Only the owner can create a file
 * in a folder that is theirs alone, so the socket's owner is the process that listens on it.
 */
export function checkNodeSocket(socket: string, uid: number, stat: StatOf = fs.statSync): void {
  const dir = stat(path.dirname(socket))
  const file = stat(socket)
  if (dir.uid !== uid || (dir.mode & OWNER_ONLY) !== 0) {
    throw new Error(`The node's folder ${path.dirname(socket)} must belong to this user alone`)
  }
  if (file.uid !== uid) {
    throw new Error(`The node socket ${socket} belongs to another user`)
  }
  if ((file.mode & OWNER_ONLY) !== 0) {
    throw new Error(`Other users can reach the node socket ${socket}`)
  }
}
