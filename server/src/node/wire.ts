import type { RawData } from 'ws'

/** A frame as it came off the socket, parsed; null when it is not JSON, which no frame fits. */
export function readFrame(data: RawData): unknown {
  const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(new Uint8Array(data))
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch {
    return null
  }
}
