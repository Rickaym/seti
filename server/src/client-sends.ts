import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { HttpError } from './http.js'
import { clientSends, type SendClaim, type SendKey, type SendKind } from './store/client-sends.js'

export type { SendKey } from './store/client-sends.js'

/** A repeat within this long returns the first result; later it is a new send. */
const SEND_WINDOW_MS = 24 * 60 * 60 * 1000
const PRUNE_EVERY_MS = 60 * 60 * 1000
const POLL_MS = 100
/** Under the client's own timeout, so a repeat that waits this long can still answer. */
const WAIT_MS = 15_000

/** This process; a claim another process left pending died with it. */
const OWNER = randomUUID()
let prunedAt = 0

export const sendKey = (kind: SendKind, target: string, clientId: string | undefined): SendKey | null =>
  clientId === undefined ? null : { kind, target, clientId }

/** Claims the send, pruning expired claims at most once an hour. */
export async function claimSend<T>(key: SendKey): Promise<SendClaim<T>> {
  const now = Date.now()
  const expired = new Date(now - SEND_WINDOW_MS).toISOString()
  if (now - prunedAt > PRUNE_EVERY_MS) {
    prunedAt = now
    await clientSends.prune(expired)
  }
  return clientSends.claim<T>(key, OWNER, new Date(now).toISOString(), expired)
}

export const finishSend = async (key: SendKey, result: unknown) => clientSends.finish(key, result)

export const releaseSend = async (key: SendKey) => clientSends.release(key)

/** The first send's result, or null once this request holds the claim and must run the send. */
async function firstResult(key: SendKey): Promise<{ result: unknown } | null> {
  const deadline = Date.now() + WAIT_MS
  for (;;) {
    const claim = await claimSend(key)
    if (claim.state === 'run') {
      return null
    }
    if (claim.state === 'done') {
      return { result: claim.result }
    }
    if (Date.now() >= deadline) {
      throw new HttpError(503, 'The same message is still being sent; try again shortly')
    }
    await sleep(POLL_MS)
  }
}

/** How a send's result is kept for a repeat and read back for it. */
export interface SendCodec<T, S> {
  save: (value: T) => S
  load: (saved: S) => T | Promise<T>
}

/**
 * Runs the send once per key: a repeat waits for the first and gets its result, with no second
 * effect. A failed send releases its claim, so a retry runs it again. No key runs it plainly.
 */
export async function sendOnce<T, S>(key: SendKey | null, run: () => Promise<T>, codec: SendCodec<T, S>): Promise<T> {
  if (key === null) {
    return run()
  }
  const first = await firstResult(key)
  if (first !== null) {
    return await codec.load(first.result as S)
  }
  let value: T
  try {
    value = await run()
  } catch (e) {
    await releaseSend(key)
    throw e
  }
  await finishSend(key, codec.save(value))
  return value
}
