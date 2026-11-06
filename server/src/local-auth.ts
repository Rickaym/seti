import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { credential } from './credentials.js'

/** Who a local request speaks for: the user (browser, scripts) or the EA voice bot. */
type LocalCaller = 'user' | 'ea'

/** Shorter values are refused, so a mistyped credential cannot become a guessable token. */
const TOKEN_MIN = 32
const COOKIE = 'seti_local'
const COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60
const SESSION_LABEL = 'seti-local-session'

export interface LocalTokens {
  user: string | null
  ea: string | null
}

export interface LocalAuth {
  /** The caller a request's bearer token or session cookie names, or null. */
  identify: (c: Context) => LocalCaller | null
  /** The caller a presented token belongs to, or null. */
  caller: (token: string) => LocalCaller | null
  startSession: (c: Context) => void
  endSession: (c: Context) => void
}

const digest = (value: string) => createHash('sha256').update(value).digest()

const usable = (token: string | null) => (token !== null && token.length >= TOKEN_MIN ? token : null)

export function readLocalTokens(): LocalTokens {
  return { user: usable(credential('local-token-user')), ea: usable(credential('local-token-ea')) }
}

const BEARER = /^Bearer\s+(\S+)$/i

/** Verifies local tokens in constant time; the browser cookie holds an HMAC of the user token. */
export function localAuth(tokens: LocalTokens): LocalAuth {
  const known = (['user', 'ea'] as const).flatMap((caller) => {
    const token = usable(tokens[caller])
    return token === null ? [] : [{ caller, digest: digest(token) }]
  })
  const session = tokens.user === null ? null : createHmac('sha256', tokens.user).update(SESSION_LABEL).digest()
  const caller = (token: string): LocalCaller | null => {
    const presented = digest(token)
    return known.find((entry) => timingSafeEqual(entry.digest, presented))?.caller ?? null
  }
  const fromCookie = (value: string | undefined): LocalCaller | null => {
    if (session === null || value === undefined) {
      return null
    }
    const presented = Buffer.from(value, 'base64url')
    return presented.length === session.length && timingSafeEqual(presented, session) ? 'user' : null
  }
  return {
    identify: (c) => {
      const bearer = BEARER.exec(c.req.header('authorization') ?? '')?.[1]
      return bearer === undefined ? fromCookie(getCookie(c, COOKIE)) : caller(bearer)
    },
    caller,
    startSession: (c) => {
      if (session === null) {
        return
      }
      setCookie(c, COOKIE, session.toString('base64url'), {
        path: '/',
        httpOnly: true,
        sameSite: 'Strict',
        maxAge: COOKIE_MAX_AGE_S,
      })
    },
    endSession: (c) => {
      deleteCookie(c, COOKIE, { path: '/' })
    },
  }
}

let fromCredentials: LocalAuth | null = null

/** Local auth from the server's credentials, read once. */
export function defaultLocalAuth(): LocalAuth {
  fromCredentials ??= localAuth(readLocalTokens())
  return fromCredentials
}
