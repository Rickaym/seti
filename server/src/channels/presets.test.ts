import { timeOf, type WebhookMapping } from '@seti/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { atPointer } from './payload.js'
import { parseGeneric } from './preset-generic.js'
import { createRateLimiter } from './rate-limit.js'
import { hmacHex, newHookId, newSecret, safeEqual, HOOK_ID } from './signature.js'
import { webhookSources } from './sources.js'
import type { Parsed, WebhookRequest } from './types.js'
import { modHost } from '../mods/bundled.js'

beforeAll(async () => {
  await modHost.start()
})

afterAll(() => {
  modHost.stopAll()
})

const SOURCE_IDS = { generic: 'generic', github: 'github-webhooks.github', sentry: 'sentry-webhooks.sentry' } as const

/** A preset of Seti or a bundled mod, which reads a payload at once rather than in mod logic. */
function adapterOf(id: string) {
  const source = webhookSources.get(id)
  if (source === undefined) {
    throw new Error(`${id} is not registered`)
  }
  const { adapter } = source
  return {
    ...adapter,
    parse: (...args: Parameters<typeof adapter.parse>): Parsed => {
      const parsed = adapter.parse(...args)
      if (parsed instanceof Promise) {
        throw new Error(`${id} reads payloads later, not at once`)
      }
      return parsed
    },
  }
}

const SECRET = ['not', 'a', 'real', 'secret', 'for', 'tests'].join('-')
const OTHER = ['another', 'fake', 'secret', 'for', 'tests'].join('-')

const request = (body: string, headers: Record<string, string> = {}): WebhookRequest => ({
  headers: new Headers({ 'content-type': 'application/json', ...headers }),
  body: Buffer.from(body),
})

const fieldsOf = (parsed: Parsed) => {
  if (parsed.kind !== 'event') {
    throw new Error(`expected an event, got: ${parsed.reason}`)
  }
  return parsed.fields
}

const context = (mapping: WebhookMapping = {}) => ({ channelName: 'Alerts', mapping })

describe('signatures', () => {
  it('compares in constant time and issues unguessable ids and prefixed secrets', () => {
    expect(safeEqual('abc', 'abc')).toBe(true)
    expect(safeEqual('abc', 'abd')).toBe(false)
    expect(safeEqual('abc', 'abcd')).toBe(false)
    expect(newHookId()).toMatch(HOOK_ID)
    expect(newHookId()).not.toBe(newHookId())
    expect(newSecret()).toMatch(/^whsec_[\w-]{43}$/)
  })

  it('generic: HMAC in X-Seti-Signature, or the secret as a bearer token', () => {
    const { verify } = adapterOf(SOURCE_IDS.generic)
    const body = '{"title":"x"}'
    expect(verify(request(body, { 'x-seti-signature': `sha256=${hmacHex(SECRET, body)}` }), SECRET)).toEqual({
      ok: true,
    })
    expect(
      verify(request(body, { 'x-seti-signature': `SHA256=${hmacHex(SECRET, body).toUpperCase()}` }), SECRET).ok,
    ).toBe(true)
    expect(verify(request(body, { 'x-seti-signature': `sha256=${hmacHex(OTHER, body)}` }), SECRET)).toEqual({
      ok: false,
      reason: 'signature mismatch',
    })
    expect(verify(request(body, { 'x-seti-signature': hmacHex(SECRET, body) }), SECRET).ok).toBe(false)
    expect(verify(request(body), SECRET)).toEqual({ ok: false, reason: 'missing signature' })
    expect(verify(request(body, { authorization: `Bearer ${SECRET}` }), SECRET)).toEqual({ ok: true })
    expect(verify(request(body, { authorization: `Bearer ${OTHER}` }), SECRET)).toEqual({
      ok: false,
      reason: 'bearer secret mismatch',
    })
    const both = { authorization: `Bearer ${SECRET}`, 'x-seti-signature': 'sha256=00' }
    expect(verify(request(body, both), SECRET).ok).toBe(false)
  })

  it('github: X-Hub-Signature-256 over the raw body', () => {
    const { verify } = adapterOf(SOURCE_IDS.github)
    const body = '{"zen":"Keep it logically awesome."}'
    expect(verify(request(body, { 'x-hub-signature-256': `sha256=${hmacHex(SECRET, body)}` }), SECRET).ok).toBe(true)
    expect(verify(request(`${body} `, { 'x-hub-signature-256': `sha256=${hmacHex(SECRET, body)}` }), SECRET).ok).toBe(
      false,
    )
    expect(verify(request(body, { 'x-hub-signature': `sha1=${hmacHex(SECRET, body)}` }), SECRET)).toEqual({
      ok: false,
      reason: 'missing signature',
    })
  })

  it('sentry: bare hex in Sentry-Hook-Signature', () => {
    const { verify } = adapterOf(SOURCE_IDS.sentry)
    const body = '{"action":"created"}'
    expect(verify(request(body, { 'sentry-hook-signature': hmacHex(SECRET, body) }), SECRET).ok).toBe(true)
    expect(verify(request(body, { 'sentry-hook-signature': hmacHex(OTHER, body) }), SECRET).ok).toBe(false)
    expect(verify(request(body), SECRET).ok).toBe(false)
  })

  it('every preset verifies and reads its own test sample', () => {
    expect(webhookSources.list().map((source) => source.info.id)).toEqual(Object.values(SOURCE_IDS))
    for (const id of Object.values(SOURCE_IDS)) {
      const preset = adapterOf(id)
      const sample = preset.sample(SECRET, 'nonce-1')
      const sent = request(sample.body, sample.headers)
      expect(preset.verify(sent, SECRET), id).toEqual({ ok: true })
      expect(preset.verify(sent, OTHER).ok, id).toBe(false)
      expect(preset.deliveryId(sent.headers), id).toBe('nonce-1')
      const decoded = preset.decode(sent)
      expect(decoded.ok, id).toBe(true)
      const fields = fieldsOf(preset.parse(decoded.ok ? decoded.payload : null, sent.headers, context()))
      expect(fields.title, id).toContain('Test event from Seti')
    }
  })
})

describe('decoding', () => {
  it('takes JSON, refuses other types and broken JSON, and reads GitHub form bodies', () => {
    expect(adapterOf(SOURCE_IDS.generic).decode(request('{"a":1}'))).toEqual({ ok: true, payload: { a: 1 } })
    expect(
      adapterOf(SOURCE_IDS.generic).decode(request('{"a":1}', { 'content-type': 'application/vnd.x+json' })).ok,
    ).toBe(true)
    expect(
      adapterOf(SOURCE_IDS.generic).decode(request('a=1', { 'content-type': 'application/x-www-form-urlencoded' })),
    ).toEqual({
      ok: false,
      status: 415,
      reason: 'unsupported content type application/x-www-form-urlencoded',
    })
    expect(adapterOf(SOURCE_IDS.sentry).decode(request('{nope'))).toEqual({
      ok: false,
      status: 400,
      reason: 'body is not valid JSON',
    })
    const form = `payload=${encodeURIComponent('{"zen":"hi"}')}`
    const formRequest = request(form, { 'content-type': 'application/x-www-form-urlencoded' })
    expect(adapterOf(SOURCE_IDS.github).decode(formRequest)).toEqual({ ok: true, payload: { zen: 'hi' } })
    const empty = request('x=1', { 'content-type': 'application/x-www-form-urlencoded' })
    expect(adapterOf(SOURCE_IDS.github).decode(empty).ok).toBe(false)
  })
})

describe('GitHub payloads', () => {
  const parse = (event: string, payload: unknown) =>
    adapterOf(SOURCE_IDS.github).parse(payload, new Headers({ 'x-github-event': event }), context())
  const repository = { full_name: 'acme/web', html_url: 'https://github.com/acme/web' }
  const run = (conclusion: string | null, action = 'completed') => ({
    action,
    repository,
    workflow_run: {
      name: 'CI',
      head_branch: 'main',
      conclusion,
      html_url: 'https://github.com/acme/web/actions/runs/1',
      updated_at: '2026-09-28T10:00:00Z',
    },
  })

  it('reports workflow runs failing and passing again as state changes of the workflow', () => {
    expect(fieldsOf(parse('workflow_run', run('failure')))).toEqual({
      source: 'GitHub acme/web',
      severity: 'critical',
      title: 'CI failed on main',
      detail: '',
      url: 'https://github.com/acme/web/actions/runs/1',
      subject: 'workflow:acme/web:CI:main',
      state: 'down',
      occurred_at: '2026-09-28T10:00:00.000Z',
      kind: 'workflow_run.completed',
    })
    expect(fieldsOf(parse('workflow_run', run('success')))).toMatchObject({ state: 'up', severity: 'success' })
    expect(parse('workflow_run', run(null, 'in_progress'))).toEqual({
      kind: 'ignore',
      reason: 'workflow_run in_progress',
    })
    expect(parse('workflow_run', run('cancelled')).kind).toBe('ignore')
  })

  it('reports deployments, pull requests, issues and pushes, and ignores pings and other actions', () => {
    const deployment = {
      repository,
      deployment_status: { state: 'failure', environment: 'production', target_url: 'https://ci.example.com/1' },
    }
    expect(fieldsOf(parse('deployment_status', deployment))).toMatchObject({
      title: 'Deployment to production failed',
      subject: 'deployment:acme/web:production',
      state: 'down',
    })
    const pr = {
      action: 'closed',
      repository,
      sender: { login: 'ann' },
      pull_request: { number: 7, title: 'Fix', merged: true, html_url: 'https://github.com/acme/web/pull/7' },
    }
    expect(fieldsOf(parse('pull_request', pr))).toMatchObject({
      severity: 'success',
      title: 'PR #7 merged: Fix',
      detail: 'In acme/web by ann.',
      kind: 'pull_request.closed',
    })
    expect(parse('pull_request', { ...pr, action: 'labeled' })).toEqual({
      kind: 'ignore',
      reason: 'pull_request labeled',
    })
    const issue = { action: 'opened', repository, sender: { login: 'bo' }, issue: { number: 3, title: 'Bug' } }
    expect(fieldsOf(parse('issues', issue))).toMatchObject({ title: 'Issue #3 opened: Bug', url: null })
    const push = {
      ref: 'refs/heads/main',
      commits: [{}, {}],
      pusher: { name: 'cy' },
      repository,
      compare: 'https://github.com/acme/web/compare/a...b',
    }
    expect(fieldsOf(parse('push', push))).toMatchObject({
      title: '2 commits pushed to main',
      detail: 'By cy.',
      kind: 'push',
    })
    expect(parse('ping', { zen: 'hi' })).toEqual({ kind: 'ignore', reason: 'ping' })
    expect(parse('release', { action: 'created', repository }).kind).toBe('ignore')
    expect(fieldsOf(parse('star', { action: 'created', repository }))).toMatchObject({
      title: 'GitHub star created in acme/web',
      url: 'https://github.com/acme/web',
    })
    expect(adapterOf(SOURCE_IDS.github).parse({}, new Headers(), context())).toEqual({
      kind: 'ignore',
      reason: 'no X-GitHub-Event header',
    })
  })
})

describe('Sentry payloads', () => {
  const parse = (resource: string, payload: unknown) =>
    adapterOf(SOURCE_IDS.sentry).parse(payload, new Headers({ 'sentry-hook-resource': resource }), context())
  const issue = (action: string, extra: Record<string, unknown> = {}) => ({
    action,
    data: {
      issue: {
        id: '42',
        title: 'TypeError: x is undefined',
        culprit: 'app/main.ts',
        level: 'error',
        web_url: 'https://acme.sentry.io/issues/42/',
        project: { slug: 'web' },
        ...extra,
      },
    },
  })
  const uptime = {
    issueCategory: 'uptime',
    issueType: 'uptime_domain_failure',
    title: 'Downtime detected for https://acme.com',
  }

  it('reports uptime issues as a monitor going down and coming back', () => {
    expect(fieldsOf(parse('issue', issue('created', uptime)))).toMatchObject({
      source: 'Sentry web',
      severity: 'critical',
      title: 'Downtime detected for https://acme.com',
      subject: 'issue:42',
      state: 'down',
      kind: 'issue.created',
    })
    expect(fieldsOf(parse('issue', issue('resolved', uptime)))).toMatchObject({
      severity: 'success',
      title: 'Resolved: Downtime detected for https://acme.com',
      state: 'up',
    })
  })

  it('reports new, regressed and resolved issues, issue alerts, metric alerts and errors', () => {
    expect(fieldsOf(parse('issue', issue('created')))).toMatchObject({
      severity: 'warning',
      title: 'New issue: TypeError: x is undefined',
      detail: 'app/main.ts',
      url: 'https://acme.sentry.io/issues/42/',
    })
    expect(fieldsOf(parse('issue', issue('created', { level: 'fatal' }))).severity).toBe('critical')
    expect(fieldsOf(parse('issue', issue('unresolved'))).title).toBe('Regressed: TypeError: x is undefined')
    expect(fieldsOf(parse('issue', issue('resolved')))).toMatchObject({ severity: 'success' })
    expect(fieldsOf(parse('issue', issue('resolved'))).state).toBeUndefined()
    expect(parse('issue', issue('assigned'))).toEqual({ kind: 'ignore', reason: 'issue assigned' })

    const alert = {
      action: 'triggered',
      data: {
        event: { title: 'Boom', level: 'error', web_url: 'https://acme.sentry.io/e/1/' },
        triggered_rule: 'Errors',
      },
    }
    expect(fieldsOf(parse('event_alert', alert))).toMatchObject({
      severity: 'critical',
      title: 'Boom',
      detail: 'Alert rule "Errors" fired.',
      kind: 'event_alert.triggered',
    })

    const metric = (action: string) => ({
      action,
      data: {
        metric_alert: { id: '9', alert_rule: { name: 'p95 latency' } },
        description_text: 'p95 over 2 s',
        web_url: 'https://acme.sentry.io/alerts/9/',
      },
    })
    expect(fieldsOf(parse('metric_alert', metric('critical')))).toMatchObject({
      title: 'p95 latency',
      state: 'down',
      subject: 'metric_alert:9',
    })
    expect(fieldsOf(parse('metric_alert', metric('warning'))).state).toBeUndefined()
    expect(fieldsOf(parse('metric_alert', metric('resolved')))).toMatchObject({ state: 'up', severity: 'success' })
    expect(
      fieldsOf(parse('error', { action: 'created', data: { error: { title: 'Oops', level: 'warning' } } })),
    ).toMatchObject({
      title: 'Oops',
      severity: 'warning',
    })
    expect(parse('installation', { action: 'created' })).toEqual({ kind: 'ignore', reason: 'installation created' })
  })
})

describe('generic payloads', () => {
  it('reads common fields at the root or in a usual envelope', () => {
    expect(
      fieldsOf(
        parseGeneric(
          {
            title: 'Disk almost full\nsecond line',
            message: 'db-1 at 91%',
            level: 'warn',
            link: 'https://grafana.example.com/d/1',
            source: 'grafana',
            timestamp: 1_790_000_000,
          },
          context(),
        ),
      ),
    ).toEqual({
      source: 'grafana',
      severity: 'warning',
      title: 'Disk almost full',
      detail: 'db-1 at 91%',
      url: 'https://grafana.example.com/d/1',
      occurred_at: new Date(1_790_000_000_000).toISOString(),
      kind: '',
    })
    const nested = fieldsOf(parseGeneric({ data: { summary: 'Queue backed up', severity: 'P1' } }, context()))
    expect(nested).toMatchObject({ title: 'Queue backed up', severity: 'critical', source: 'Alerts', url: null })
    expect(fieldsOf(parseGeneric({ text: 'Plain note' }, context()))).toMatchObject({ title: 'Plain note', detail: '' })
    expect(fieldsOf(parseGeneric({ foo: 1 }, context())).title).toBe('Event from Alerts')
    expect(parseGeneric('a string', context())).toEqual({ kind: 'ignore', reason: 'payload is not a JSON object' })
    expect(fieldsOf(parseGeneric({ title: 'x', url: 'javascript:alert(1)' }, context())).url).toBeNull()
  })

  it('tracks state only with a subject, as in an Alertmanager group', () => {
    const grafana = (status: string) => ({
      status,
      title: `[${status.toUpperCase()}] HighCPU`,
      commonLabels: { alertname: 'HighCPU' },
      externalURL: 'https://grafana.example.com',
    })
    expect(fieldsOf(parseGeneric(grafana('firing'), context()))).toMatchObject({
      subject: 'HighCPU',
      state: 'down',
      severity: 'critical',
    })
    expect(fieldsOf(parseGeneric(grafana('resolved'), context()))).toMatchObject({ state: 'up', severity: 'success' })
    const noSubject = fieldsOf(parseGeneric({ status: 'firing', message: 'x' }, context()))
    expect(noSubject.state).toBeUndefined()
    expect(noSubject.severity).toBe('info')
  })

  it('takes the channel field mapping first, and falls back when a pointer finds nothing', () => {
    const mapping = {
      title: '/alert/headline',
      kind: '/alert/type',
      severity: '/alert/prio',
      url: '/links/0/href',
      subject: '/alert/check~1id',
      state: '/alert/health',
    }
    const payload = {
      title: 'ignored title',
      alert: { headline: 'API latency', type: 'Check Failed', prio: 'high', 'check/id': 'api', health: 'unhealthy' },
      links: [{ href: 'https://status.example.com/api' }],
    }
    expect(fieldsOf(parseGeneric(payload, context(mapping)))).toMatchObject({
      title: 'API latency',
      severity: 'critical',
      url: 'https://status.example.com/api',
      subject: 'api',
      state: 'down',
      kind: 'Check Failed',
    })
    expect(fieldsOf(parseGeneric({ title: 'Fallback' }, context(mapping))).title).toBe('Fallback')
    expect(fieldsOf(parseGeneric({ title: 'Typed', type: 'deploy' }, context())).kind).toBe('deploy')
  })

  it('resolves JSON pointers and times', () => {
    const doc = { a: { 'b/c': [10, { 'd~e': 'x' }] } }
    expect(atPointer(doc, '/a/b~1c/1/d~0e')).toBe('x')
    expect(atPointer(doc, '/a/missing')).toBeUndefined()
    expect(atPointer(doc, '/a/b~1c/5')).toBeUndefined()
    expect(timeOf('2026-09-28T10:00:00+02:00')).toBe('2026-09-28T08:00:00.000Z')
    expect(timeOf(1_790_000_000_123)).toBe(new Date(1_790_000_000_123).toISOString())
    expect(timeOf('soon')).toBeNull()
  })
})

describe('rate limiter', () => {
  it('counts per key per window and flags only the first refusal', () => {
    let clock = 0
    const limit = createRateLimiter(2, 60_000, () => clock)
    expect([limit('a'), limit('a'), limit('b')].every((verdict) => verdict.ok)).toBe(true)
    expect(limit('a')).toEqual({ ok: false, first: true, retryAfterS: 60 })
    clock = 30_000
    expect(limit('a')).toEqual({ ok: false, first: false, retryAfterS: 30 })
    clock = 60_000
    expect(limit('a').ok).toBe(true)
  })
})
