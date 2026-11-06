import type { Context } from 'hono'
import { currentPublicHost } from './access.js'
import { HttpError } from './http.js'
import type { RelyingParty } from './passkeys.js'

const LOCALHOST = (hostname: string) => hostname === 'localhost' || hostname.endsWith('.localhost')

export const hostnameOf = (c: Context) => (c.req.header('host') ?? '').replace(/:\d+$/, '').toLowerCase()

/** The public host's relying party, else the localhost origin the browser called from. */
export function relyingParty(c: Context): RelyingParty {
  const publicHost = currentPublicHost()
  if (publicHost !== null) {
    return { id: publicHost.hostname, origin: publicHost.origin }
  }
  const origin = c.req.header('origin') ?? ''
  const url = URL.canParse(origin) ? new URL(origin) : null
  if (url?.protocol === 'http:' && LOCALHOST(url.hostname)) {
    return { id: url.hostname, origin: url.origin }
  }
  throw new HttpError(400, 'Passkeys work on the public hostname or at http://localhost, not at an IP address')
}
