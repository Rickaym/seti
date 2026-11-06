import {
  defineMod,
  firstText,
  isRecord,
  orNull,
  recordAt,
  textAt,
  type JsonRecord,
  type WebhookEvent,
  type WebhookParsed,
} from '@seti/mod-api'
import manifest from './seti-mod.json' with { type: 'json' }

const RESOURCE = 'sentry-hook-resource'

const LEVEL: Record<string, WebhookEvent['severity']> = { fatal: 'critical', error: 'critical', warning: 'warning' }
const levelOf = (value: string): WebhookEvent['severity'] => LEVEL[value] ?? 'info'

const event = (fields: Omit<WebhookEvent, 'occurred_at'>): WebhookParsed => ({
  kind: 'event',
  fields: { occurred_at: new Date().toISOString(), ...fields },
})

const sourceOf = (project: string) => (project === '' ? 'Sentry' : `Sentry ${project}`)

/** Uptime monitors open an issue when a check fails and resolve it when it passes again. */
const isUptime = (issue: JsonRecord) =>
  textAt(issue, 'issueCategory') === 'uptime' || textAt(issue, 'issueType').startsWith('uptime')

function issueEvent(issue: JsonRecord, action: string): WebhookParsed {
  const title = textAt(issue, 'title')
  const common = {
    source: sourceOf(textAt(recordAt(issue, 'project'), 'slug')),
    url: orNull(textAt(issue, 'web_url')),
  }
  const opened = action === 'created' || action === 'unresolved'
  if (!opened && action !== 'resolved') {
    return { kind: 'ignore', reason: `issue ${action}` }
  }
  if (isUptime(issue)) {
    const subject = `issue:${textAt(issue, 'id')}`
    return opened
      ? event({ ...common, severity: 'critical', title, detail: '', subject, state: 'down' })
      : event({ ...common, severity: 'success', title: `Resolved: ${title}`, detail: '', subject, state: 'up' })
  }
  const detail = textAt(issue, 'culprit')
  if (action === 'resolved') {
    return event({ ...common, severity: 'success', title: `Resolved: ${title}`, detail })
  }
  const label = action === 'created' ? 'New issue' : 'Regressed'
  const severity = textAt(issue, 'level') === 'fatal' ? 'critical' : 'warning'
  return event({ ...common, severity, title: `${label}: ${title}`, detail })
}

function metricAlert(data: JsonRecord, action: string): WebhookParsed {
  const alert = recordAt(data, 'metric_alert')
  const name = firstText(textAt(data, 'description_title'), textAt(recordAt(alert, 'alert_rule'), 'name'))
  const common = {
    source: 'Sentry',
    title: name === '' ? 'Sentry metric alert' : name,
    detail: textAt(data, 'description_text'),
    url: orNull(textAt(data, 'web_url')),
  }
  const subject = `metric_alert:${textAt(alert, 'id')}`
  switch (action) {
    case 'critical':
      return event({ ...common, severity: 'critical', subject, state: 'down' })
    case 'warning':
      return event({ ...common, severity: 'warning' })
    case 'resolved':
      return event({ ...common, severity: 'success', subject, state: 'up' })
    default:
      return { kind: 'ignore', reason: `metric_alert ${action}` }
  }
}

/** The resource the hook reports, and its action after a dot when the payload has one. */
function withKind(parsed: WebhookParsed, resource: string, action: string): WebhookParsed {
  if (parsed.kind !== 'event') {
    return parsed
  }
  return { kind: 'event', fields: { ...parsed.fields, kind: action === '' ? resource : `${resource}.${action}` } }
}

function parseSentry(payload: unknown, headers: Headers): WebhookParsed {
  const resource = headers.get(RESOURCE) ?? ''
  const root = isRecord(payload) ? payload : {}
  const action = textAt(root, 'action')
  const data = recordAt(root, 'data')
  switch (resource) {
    case 'issue':
      return issueEvent(recordAt(data, 'issue'), action)
    case 'event_alert': {
      const alerted = recordAt(data, 'event')
      const rule = textAt(data, 'triggered_rule')
      return event({
        source: 'Sentry',
        severity: levelOf(textAt(alerted, 'level')),
        title: firstText(textAt(alerted, 'title'), 'Sentry issue alert'),
        detail: rule === '' ? '' : `Alert rule "${rule}" fired.`,
        url: orNull(firstText(textAt(alerted, 'web_url'), textAt(alerted, 'issue_url'))),
      })
    }
    case 'metric_alert':
      return metricAlert(data, action)
    case 'error': {
      const error = recordAt(data, 'error')
      return event({
        source: 'Sentry',
        severity: levelOf(textAt(error, 'level')),
        title: firstText(textAt(error, 'title'), 'Sentry error'),
        detail: textAt(error, 'culprit'),
        url: orNull(textAt(error, 'web_url')),
      })
    }
    default:
      return { kind: 'ignore', reason: resource === '' ? 'no Sentry-Hook-Resource header' : `${resource} ${action}` }
  }
}

/** Reads Sentry's deliveries; Seti checks Sentry-Hook-Signature before any of this runs. */
export const sentryWebhooksServer = defineMod({
  manifest,
  server: (api) => {
    api.registerWebhookSource('sentry', {
      parse: (payload, headers) => {
        const root = isRecord(payload) ? payload : {}
        return withKind(parseSentry(payload, headers), headers.get(RESOURCE) ?? '', textAt(root, 'action'))
      },
      sample: () => ({
        headers: { 'content-type': 'application/json', [RESOURCE]: 'event_alert' },
        body: JSON.stringify({
          action: 'triggered',
          data: {
            event: { title: 'Test event from Seti', level: 'info', web_url: 'https://sentry.io/' },
            triggered_rule: 'Seti test',
          },
        }),
      }),
    })
  },
})
