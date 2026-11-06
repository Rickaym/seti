import { hostAllowed, hostsWithin, VALUE_PLACEHOLDER } from '@seti/shared'
import { z } from 'zod'
import { audit } from '../../audit.js'
import { connectionRule } from '../../connection-egress.js'
import { HttpError } from '../../http.js'
import { redactValues, type PollResponse } from '../../pollers/fetch.js'
import { connectionRows, type ConnectionRow } from '../../store/connections.js'
import type { ModCall } from '../capabilities.js'
import { fetchTarget, grantOf } from '../scopes.js'
import { defineOp, type OpContext } from './define.js'
import { fetchInit, onPort443, sendModFetch } from './net.js'

const SLOT = 'connection'

const connectionArgs = z.strictObject({ ...fetchInit, connection: z.string().max(64) })

/** The connection row the user bound to the grant, read now, so a deleted one is gone at once. */
async function boundRow(call: ModCall, variable: string): Promise<{ row: ConnectionRow; hosts: readonly string[] }> {
  const grant = grantOf(call, 'connection')
  if (variable !== grant.variable) {
    throw new HttpError(403, `The mod ${call.modId} was not granted the connection ${variable}`)
  }
  const row = grant.connectionId === null ? undefined : await connectionRows.get(grant.connectionId)
  if (row?.env !== grant.variable) {
    throw new HttpError(403, `The ${variable} connection is gone; the user binds another in Settings, Mods`)
  }
  if (row.header === null) {
    throw new HttpError(403, `The ${variable} connection sends its key in the body or URL, which mods cannot use`)
  }
  return { row, hosts: grant.hosts }
}

async function auditBlocked(call: ModCall, host: string, row: ConnectionRow): Promise<void> {
  await audit.record({
    actor: 'user',
    kind: 'mod.api_key_blocked',
    subject_type: 'mod',
    subject_id: call.modId,
    summary: `Blocked a request of the mod ${call.modId} to ${host} with the connection ${row.name}`,
    detail: { host, connection: row.name },
  })
}

/** The header value and the bare key inside it, so an echo of either comes back redacted. */
function valuesOf(row: ConnectionRow, sent: readonly string[]): string[] {
  const [before = '', after = ''] = (row.header?.template ?? VALUE_PLACEHOLDER).split(VALUE_PLACEHOLDER)
  return sent.flatMap((value) => [value, value.slice(before.length, value.length - after.length)])
}

const redacted = (response: PollResponse, values: readonly string[]): PollResponse => ({
  status: response.status,
  url: redactValues(response.url, values),
  headers: response.headers.map(([name, value]): [string, string] => [name, redactValues(value, values)]),
  body: redactValues(response.body, values),
})

/**
 * A fetch with the user's connection: Seti reads the value here, in its own process, sets the
 * header, and redacts the value from everything that goes back. The mod never holds it.
 */
async function connectionFetch(
  args: z.output<typeof connectionArgs>,
  { call, secret }: OpContext,
): Promise<PollResponse> {
  const { row, hosts } = await boundRow(call, args.connection)
  const url = fetchTarget(call, args.url, hosts, 'connection')
  if (!hostAllowed(row.hosts, url.hostname)) {
    await auditBlocked(call, url.hostname, row)
    throw new HttpError(403, `${url.hostname} is not a host of the ${row.env} connection`)
  }
  const header = row.header?.name.toLowerCase() ?? ''
  const rule = connectionRule(row, { name: header, template: row.header?.template ?? VALUE_PLACEHOLDER })
  const headers = Object.fromEntries(
    Object.entries(args.headers ?? {}).filter(([name]) => name.toLowerCase() !== header),
  )
  const sent: string[] = []
  const send = async (value: string) => {
    sent.push(value)
    valuesOf(row, [value]).forEach(secret)
    return sendModFetch(call, {
      url,
      init: { method: args.method, headers, body: args.body, secretHeaders: { [header]: `{{${SLOT}}}` } },
      allowed: onPort443(hostsWithin(hosts, row.hosts)),
      secrets: new Map([[SLOT, value]]),
    })
  }
  try {
    const value = await rule.value(url)
    if (value === null) {
      throw new HttpError(409, `The ${row.env} connection has no value; the user sets it in Settings, Connections`)
    }
    const first = await send(value)
    const renewed = first.status === 401 && rule.renew !== undefined ? await rule.renew(url, value) : null
    return redacted(renewed === null ? first : await send(renewed), valuesOf(row, sent))
  } catch (e) {
    const message = redactValues(e instanceof Error ? e.message : String(e), valuesOf(row, sent))
    throw new HttpError(e instanceof HttpError ? e.status : 502, message)
  }
}

export const connectionOps = {
  'connection.fetch': defineOp({ args: connectionArgs, run: connectionFetch }),
}
