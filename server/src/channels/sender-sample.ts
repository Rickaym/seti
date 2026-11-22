import {
  CUSTOM_WEBHOOK_SOURCE,
  normalizeEventKind,
  webhookSenderById,
  type SenderDefinition,
  type SenderSampleResult,
  type senderSampleInput,
} from '@seti/shared'
import type { z } from 'zod'
import { HttpError } from '../http.js'
import { redactCredentials } from '../scrub.js'
import { channelStore } from '../store/channels.js'
import { readSenderEvent } from './sender-adapter.js'
import { checkSender } from './sender-verify.js'
import type { WebhookRequest } from './types.js'

interface Checker {
  definition: SenderDefinition
  secret: string
  names: { sender: string; channel: string }
}

const NOT_DESCRIBED = 'Only a webhook whose sender is described as data takes a sample'

/** A webhook's own sender and sealed secret. */
async function channelChecker(id: string): Promise<Checker> {
  const record = await channelStore.get(id)
  if (record === undefined) {
    throw new HttpError(404, 'No such webhook')
  }
  const listed = webhookSenderById(record.preset)
  const definition = record.preset === CUSTOM_WEBHOOK_SOURCE ? record.sender : (listed?.definition ?? null)
  if (definition === null) {
    throw new HttpError(400, NOT_DESCRIBED)
  }
  if (record.secret === null || record.secret_pending === 'paste') {
    throw new HttpError(409, 'This webhook has no usable secret yet; paste or rotate it first')
  }
  return { definition, secret: record.secret, names: { sender: listed?.title ?? record.name, channel: record.name } }
}

async function checkerOf(input: z.output<typeof senderSampleInput>): Promise<Checker> {
  if (input.channel_id !== undefined) {
    return channelChecker(input.channel_id)
  }
  const listed = input.preset === undefined ? undefined : webhookSenderById(input.preset)
  const definition = input.definition ?? listed?.definition
  if (definition === undefined) {
    throw new HttpError(400, NOT_DESCRIBED)
  }
  if (input.secret === undefined) {
    throw new HttpError(400, 'Enter the secret to check the sample with')
  }
  const sender = listed?.title ?? 'Custom'
  return { definition, secret: input.secret, names: { sender, channel: sender } }
}

/** Headers as copied from a request log: one `Name: value` a line; other lines are skipped. */
export function pastedHeaders(text: string): Headers {
  const headers = new Headers()
  for (const line of text.split('\n')) {
    const at = line.indexOf(':')
    const name = line.slice(0, Math.max(at, 0)).trim()
    if (/^[A-Za-z][A-Za-z0-9-]*$/.test(name)) {
      headers.set(name, line.slice(at + 1).trim())
    }
  }
  return headers
}

function parsed(body: Buffer): { payload: unknown } | null {
  try {
    return { payload: JSON.parse(body.toString('utf8')) as unknown }
  } catch {
    return null
  }
}

/**
 * Checks a pasted request as a delivery would be checked, storing nothing. A copied body often
 * gains or loses its last line break, so the body is tried as pasted and without that ending.
 */
export async function checkSample(input: z.output<typeof senderSampleInput>): Promise<SenderSampleResult> {
  const { definition, secret, names } = await checkerOf(input)
  const headers = pastedHeaders(input.headers)
  const bodies = [...new Set([input.body, input.body.trimEnd()])].map((text) => Buffer.from(text, 'utf8'))
  const tries = bodies.map((body) => {
    const request: WebhookRequest = { headers, body }
    return { request, ...checkSender(definition, request, secret, Date.now()) }
  })
  const match = tries.find((entry) => entry.signed)
  if (match === undefined) {
    const reason = tries[0]?.verdict.ok === false ? tries[0].verdict.reason : 'signature mismatch'
    return { verified: false, reason, event: null }
  }
  const live = match.verdict.ok ? '' : `A live delivery like this is refused: ${match.verdict.reason}`
  const json = parsed(match.request.body)
  if (json === null) {
    return { verified: true, reason: live === '' ? 'The body is not JSON, so it makes no update' : live, event: null }
  }
  const fields = readSenderEvent(definition, json.payload, headers, names)
  const event = {
    kind: normalizeEventKind(fields.kind ?? ''),
    title: redactCredentials(fields.title),
    url: fields.url,
  }
  return { verified: true, reason: live, event }
}
