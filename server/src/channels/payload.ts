import { isRecord, type ChannelState, type EaNoticeSeverity } from '@seti/shared'
import type { WebhookRequest, WebhookPresetAdapter } from './types.js'

/** The value a JSON pointer (RFC 6901) names, or undefined. */
export function atPointer(value: unknown, pointer: string): unknown {
  let current = value
  for (const raw of pointer.split('/').slice(1)) {
    const key = raw.replaceAll('~1', '/').replaceAll('~0', '~')
    if (Array.isArray(current) && /^\d+$/.test(key)) {
      current = current[Number(key)]
    } else if (isRecord(current) && Object.hasOwn(current, key)) {
      current = current[key]
    } else {
      return undefined
    }
  }
  return current
}

const SEVERITY_WORDS: Record<EaNoticeSeverity, readonly string[]> = {
  critical: ['critical', 'crit', 'fatal', 'emergency', 'alert', 'error', 'high', 'major', 'p1', 'sev1', 'down'],
  warning: ['warning', 'warn', 'medium', 'minor', 'degraded', 'p2', 'p3', 'sev2', 'sev3'],
  success: ['ok', 'success', 'succeeded', 'resolved', 'recovered', 'up', 'healthy', 'passed', 'green'],
  info: ['info', 'information', 'informational', 'notice', 'debug', 'low', 'p4', 'p5'],
}

const STATE_WORDS: Record<ChannelState, readonly string[]> = {
  down: ['down', 'firing', 'failing', 'alerting', 'problem', 'outage', 'triggered', 'unhealthy'],
  up: ['up', 'resolved', 'ok', 'recovered', 'healthy'],
}

function lookup<T extends string>(words: Record<T, readonly string[]>, value: string): T | null {
  const word = value.trim().toLowerCase()
  for (const [key, list] of Object.entries(words) as [T, readonly string[]][]) {
    if (list.includes(word)) {
      return key
    }
  }
  return null
}

export const severityOf = (value: string): EaNoticeSeverity | null => lookup(SEVERITY_WORDS, value)

export const stateOf = (value: string): ChannelState | null => lookup(STATE_WORDS, value)

const JSON_TYPE = /^(application\/([\w.+-]+\+)?json|text\/plain)\b/i

/** Only a JSON body is accepted; text/plain and a missing type are read as JSON too. */
export function decodeJson(request: WebhookRequest): ReturnType<WebhookPresetAdapter['decode']> {
  const type = request.headers.get('content-type') ?? ''
  if (type !== '' && !JSON_TYPE.test(type)) {
    return { ok: false, status: 415, reason: `unsupported content type ${type.split(';')[0] ?? ''}` }
  }
  return parseJsonText(request.body.toString('utf8'))
}

export function parseJsonText(text: string): ReturnType<WebhookPresetAdapter['decode']> {
  try {
    return { ok: true, payload: JSON.parse(text) }
  } catch {
    return { ok: false, status: 400, reason: 'body is not valid JSON' }
  }
}

export const firstLine = (text: string) => text.split('\n', 1)[0]?.trim() ?? ''
