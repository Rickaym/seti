import dns from 'node:dns/promises'
import { MOD_LIMITS } from '@seti/shared'
import { z } from 'zod'
import { MOD_TEST_UPSTREAM } from '../../config.js'
import { HttpError } from '../../http.js'
import { createPollFetch, type PollResponse } from '../../pollers/fetch.js'
import { redactSecrets } from '../../scrub.js'
import type { ModCall } from '../capabilities.js'
import { fetchTarget, grantOf, setiHostProblem } from '../scopes.js'
import { defineOp, type OpContext } from './define.js'

/** What one mod fetch may send, as the mod gives it; credentials go through a connection only. */
export const fetchInit = {
  url: z.string().max(8192),
  method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
  headers: z.record(z.string().max(200), z.string().max(8192)).optional(),
  body: z.string().max(MOD_LIMITS.fetchBodyBytes).optional(),
}

/** A fetch request in the shape createPollFetch takes, with any secret headers it adds. */
interface FetchPlan {
  url: URL
  init: {
    method?: string | undefined
    headers?: Record<string, string> | undefined
    body?: string | undefined
    secretHeaders?: Record<string, string>
  }
  /** Every granted pattern on port 443, so a redirect stays on the grant too. */
  allowed: readonly string[]
  secrets: ReadonlyMap<string, string>
}

/** Resolves a name for a mod's request; Seti's own names are refused on every hop. */
async function modLookup(host: string): Promise<{ address: string; family: number }[]> {
  const seti = setiHostProblem(host)
  if (seti !== null) {
    throw new HttpError(403, seti)
  }
  return dns.lookup(host, { all: true, order: 'verbatim' })
}

/** Names under the reserved .test TLD, which only a test run's fake upstream answers. */
const isTestName = (host: string) => host.endsWith('.test')

const NOT_ALLOWED = /^(\S+) is not on the allowed hosts/

/** The poller fetch's refusal in a mod's words, as denied; anything else failed upstream. */
function fetchError(call: ModCall, e: unknown): HttpError {
  if (e instanceof HttpError) {
    return e
  }
  const text = redactSecrets(e instanceof Error ? e.message : String(e))
  const host = NOT_ALLOWED.exec(text)?.[1]
  if (host !== undefined) {
    return new HttpError(403, `${host} is not in the hosts the mod ${call.modId} was granted`)
  }
  if (/ is refused: |cannot be set|credentials in/.test(text)) {
    return new HttpError(403, text)
  }
  return new HttpError(502, text)
}

/** Sends one mod request on the poller's fetch: public addresses only, redirects re-checked. */
export async function sendModFetch(call: ModCall, plan: FetchPlan): Promise<PollResponse> {
  const fetcher = createPollFetch({
    lookup: modLookup,
    allowed: plan.allowed,
    secrets: plan.secrets,
    responseMaxBytes: MOD_LIMITS.fetchResponseBytes,
    runResponseMaxBytes: MOD_LIMITS.fetchEventBytes,
    requestBodyMaxBytes: MOD_LIMITS.fetchBodyBytes,
    timeoutMs: MOD_LIMITS.fetchTimeoutMs,
    httpsOnly: true,
    testUpstream: MOD_TEST_UPSTREAM === null ? null : { matches: isTestName, port: MOD_TEST_UPSTREAM },
  })
  try {
    return await fetcher({ url: plan.url.toString(), init: plan.init }, AbortSignal.timeout(MOD_LIMITS.fetchTimeoutMs))
  } catch (e) {
    throw fetchError(call, e)
  }
}

export const onPort443 = (hosts: readonly string[]) => hosts.map((host) => `${host}:443`)

async function netFetch(args: z.output<z.ZodObject<typeof fetchInit>>, { call }: OpContext): Promise<PollResponse> {
  const { hosts } = grantOf(call, 'net.fetch')
  const url = fetchTarget(call, args.url, hosts, 'net.fetch')
  const { method, headers, body } = args
  return sendModFetch(call, { url, init: { method, headers, body }, allowed: onPort443(hosts), secrets: new Map() })
}

export const netOps = {
  'net.fetch': defineOp({ args: z.strictObject(fetchInit), run: netFetch }),
}
