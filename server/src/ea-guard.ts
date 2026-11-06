import { isSecurityAccess, type AccessKind } from '@seti/shared'
import type { Context, MiddlewareHandler } from 'hono'
import { currentRequestSource } from './access.js'
import { fail, HttpError } from './http.js'

/** True for a request the EA voice bot made with its own token. */
export const fromEa = (): boolean => currentRequestSource()?.via === 'ea'

/** True inside a seti tool an agent called. */
export const fromAgent = (): boolean => currentRequestSource()?.via === 'agent'

/** True inside a call a mod's server code makes through the mod API. */
const fromMod = (): boolean => currentRequestSource()?.via === 'mod'

/** True for anyone acting for the user rather than the user: the EA, an agent or a mod. */
export const fromDelegate = (): boolean => fromEa() || fromAgent() || fromMod()

/**
 * What no mod may do at any tier: run programs, see or change security settings, credentials,
 * connections or secrets, share, write as the user, or install, enable or grant mods.
 */
export function refuseMod(what: string): void {
  if (fromMod()) {
    throw new HttpError(403, `Mods cannot ${what}; only the user does that, in Seti`)
  }
}

/** The task id of the agent whose seti tools make the request while held to itself, else null. */
export function ownTaskOnly(): string | null {
  const source = currentRequestSource()
  return source?.via === 'agent' && source.scope === 'self' ? source.taskId : null
}

/** The refusal of a reach past the calling agent at Seti control Self. */
export const outsideSelf = () =>
  new HttpError(403, 'At Seti control Self your seti tools act only on you; the user can give you Full in your access')

/** At Seti control Self an agent's seti tools reach no agent but itself. */
export function refuseOtherAgent(taskId: string): void {
  const own = ownTaskOnly()
  if (own !== null && own !== taskId) {
    throw outsideSelf()
  }
}

/** Below Seti control Full an agent changes nothing every agent shares. */
export function refuseAtSelf(what: string): void {
  if (ownTaskOnly() !== null) {
    throw new HttpError(403, `Below Seti control Full you cannot ${what}; the user can give you Full in your access`)
  }
}

/** Security settings stay the user's: agents' seti tools and mods never change them. */
export function refuseAgent(what: string): void {
  refuseMod(what)
  if (fromAgent()) {
    throw new HttpError(403, `Agents cannot ${what}; only the user does that, in Seti`)
  }
}

/** Who writes a message Seti sends for the EA, an agent or a mod, such as a new agent's first one. */
export function promptAuthor(): string | undefined {
  const source = currentRequestSource()
  if (source?.via === 'ea') {
    return 'the EA'
  }
  if (source?.via === 'mod') {
    return `the ${source.modId} mod`
  }
  return source?.via === 'agent' ? `agent "${source.title}"` : undefined
}

/** The refusal of a prompt the EA or an agent would write into an agent's conversation. */
export const PROMPT_AS_USER = 'The EA and agents message agents through the group chat'

/**
 * Only the user writes an agent's prompts: the EA and agents' seti tools reach it through the
 * group chat, which marks who wrote each message, and never as the user.
 */
export function refusePromptAsUser(): void {
  refuseMod("write into an agent's conversation")
  if (fromEa() || fromAgent()) {
    throw new HttpError(403, PROMPT_AS_USER)
  }
}

/** The 403 an EA request gets for what stays the user's: secrets, security settings, commands. */
export const refuseEa = (c: Context, what: string) =>
  fail(c, 403, 'Forbidden', `The EA cannot ${what}; the user does that in Seti`)

/** Refuses every EA request to the routes it guards, whatever the EA's own tools offer. */
export const notEa =
  (what: string): MiddlewareHandler =>
  async (c, next) => {
    refuseMod(what)
    if (fromEa()) {
      return refuseEa(c, what)
    }
    await next()
    return undefined
  }

/** Like notEa, for writes only: the EA may still read what the guarded routes show. */
export const eaReadOnly =
  (what: string): MiddlewareHandler =>
  async (c, next) => {
    if (c.req.method !== 'GET') {
      refuseMod(what)
    }
    if (c.req.method !== 'GET' && fromEa()) {
      return refuseEa(c, what)
    }
    await next()
    return undefined
  }

/**
 * The 403 an EA request gets for choosing ssh hosts or AWS, for one agent or by default: those
 * are security settings the EA may view but never change. Null when the request may go on.
 */
export const eaSecurityAccessRefusal = (c: Context, kinds: readonly AccessKind[]) =>
  fromEa() && kinds.some(isSecurityAccess) ? refuseEa(c, 'choose ssh hosts or AWS for agents') : null

/** SSH hosts, keys and trusted host keys are security settings the EA may only view. */
export const eaSshReadOnly = eaReadOnly('change ssh hosts, keys or trusted host keys')
