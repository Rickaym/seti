import {
  defineMod,
  firstText,
  isRecord,
  orNull,
  recordAt,
  textAt,
  timeOf,
  type JsonRecord,
  type WebhookEvent,
  type WebhookParsed,
} from '@seti/mod-api'
import manifest from './seti-mod.json' with { type: 'json' }

const EVENT = 'x-github-event'

const FAILED = new Set(['failure', 'timed_out', 'startup_failure'])
const REPORTED_ACTIONS: Record<string, ReadonlySet<string>> = {
  pull_request: new Set(['opened', 'closed', 'reopened', 'ready_for_review']),
  issues: new Set(['opened', 'closed', 'reopened']),
  release: new Set(['published']),
}

interface Context {
  payload: JsonRecord
  repo: string
  source: string
  at: string
  /** The X-GitHub-Event, and the action after a dot when the payload has one. */
  kind: string
}

const kindOf = (name: string, action: string) => (action === '' ? name : `${name}.${action}`)

const event = (context: Context, fields: Omit<WebhookEvent, 'source' | 'occurred_at'>): WebhookParsed => ({
  kind: 'event',
  fields: { source: context.source, occurred_at: context.at, kind: context.kind, ...fields },
})

function stateEvent(context: Context, subject: string, state: 'down' | 'up', text: { title: string; url: string }) {
  return event(context, {
    severity: state === 'down' ? 'critical' : 'success',
    title: text.title,
    detail: '',
    url: orNull(text.url),
    subject,
    state,
  })
}

function workflowRun(context: Context, action: string): WebhookParsed {
  const run = recordAt(context.payload, 'workflow_run')
  const conclusion = textAt(run, 'conclusion')
  const done = action === 'completed' && (FAILED.has(conclusion) || conclusion === 'success')
  if (!done) {
    return { kind: 'ignore', reason: `workflow_run ${action} ${conclusion}`.trim() }
  }
  const name = textAt(run, 'name')
  const branch = textAt(run, 'head_branch')
  const failed = FAILED.has(conclusion)
  const title = failed ? `${name} failed on ${branch}` : `${name} passes again on ${branch}`
  const subject = `workflow:${context.repo}:${name}:${branch}`
  return stateEvent(context, subject, failed ? 'down' : 'up', { title, url: textAt(run, 'html_url') })
}

function deploymentStatus(context: Context): WebhookParsed {
  const status = recordAt(context.payload, 'deployment_status')
  const state = textAt(status, 'state')
  if (state !== 'success' && state !== 'failure' && state !== 'error') {
    return { kind: 'ignore', reason: `deployment_status ${state}` }
  }
  const environment = firstText(
    textAt(status, 'environment'),
    textAt(recordAt(context.payload, 'deployment'), 'environment'),
  )
  const down = state !== 'success'
  const title = down ? `Deployment to ${environment} failed` : `Deployment to ${environment} succeeded`
  const url = firstText(textAt(status, 'target_url'), textAt(status, 'log_url'), textAt(status, 'environment_url'))
  return stateEvent(context, `deployment:${context.repo}:${environment}`, down ? 'down' : 'up', { title, url })
}

function itemEvent(context: Context, kind: 'pull_request' | 'issues', action: string): WebhookParsed {
  const item = recordAt(context.payload, kind === 'issues' ? 'issue' : 'pull_request')
  const merged = kind === 'pull_request' && action === 'closed' && item.merged === true
  const noun = kind === 'issues' ? 'Issue' : 'PR'
  const verb = merged ? 'merged' : action.replaceAll('_', ' ')
  return event(context, {
    severity: merged ? 'success' : 'info',
    title: `${noun} #${textAt(item, 'number')} ${verb}: ${textAt(item, 'title')}`,
    detail: `In ${context.repo} by ${textAt(recordAt(context.payload, 'sender'), 'login')}.`,
    url: orNull(textAt(item, 'html_url')),
  })
}

function push(context: Context): WebhookParsed {
  const commits = Array.isArray(context.payload.commits) ? context.payload.commits.length : 0
  const ref = textAt(context.payload, 'ref').replace(/^refs\/heads\//, '')
  const pusher = textAt(recordAt(context.payload, 'pusher'), 'name')
  return event(context, {
    severity: 'info',
    title: `${String(commits)} ${commits === 1 ? 'commit' : 'commits'} pushed to ${ref}`,
    detail: pusher === '' ? '' : `By ${pusher}.`,
    url: orNull(textAt(context.payload, 'compare')),
  })
}

function parseGithub(payload: unknown, headers: Headers): WebhookParsed {
  const name = headers.get(EVENT) ?? ''
  const root = isRecord(payload) ? payload : {}
  const action = textAt(root, 'action')
  const repository = recordAt(root, 'repository')
  const repo = firstText(textAt(repository, 'full_name'), textAt(recordAt(root, 'organization'), 'login'))
  const at = timeOf(textAt(recordAt(root, 'workflow_run'), 'updated_at')) ?? new Date().toISOString()
  const source = repo === '' ? 'GitHub' : `GitHub ${repo}`
  const context: Context = { payload: root, repo, source, at, kind: kindOf(name, action) }
  const reported = REPORTED_ACTIONS[name]
  if (reported !== undefined && !reported.has(action)) {
    return { kind: 'ignore', reason: `${name} ${action}` }
  }
  switch (name) {
    case '':
      return { kind: 'ignore', reason: 'no X-GitHub-Event header' }
    case 'ping':
      return { kind: 'ignore', reason: 'ping' }
    case 'workflow_run':
      return workflowRun(context, action)
    case 'deployment_status':
      return deploymentStatus(context)
    case 'push':
      return push(context)
    case 'pull_request':
    case 'issues':
      return itemEvent(context, name, action)
    default: {
      const what = [name.replaceAll('_', ' '), action].filter((part) => part !== '').join(' ')
      return event(context, {
        severity: 'info',
        title: repo === '' ? `GitHub ${what}` : `GitHub ${what} in ${repo}`,
        detail: '',
        url: orNull(textAt(repository, 'html_url')),
      })
    }
  }
}

/** Reads GitHub's deliveries into events; Seti checks X-Hub-Signature-256 before any of this runs. */
export const githubWebhooksServer = defineMod({
  manifest,
  server: (api) => {
    api.registerWebhookSource('github', {
      parse: parseGithub,
      sample: () => ({
        headers: { 'content-type': 'application/json', [EVENT]: 'issues' },
        body: JSON.stringify({
          action: 'opened',
          issue: { number: 1, title: 'Test event from Seti', html_url: 'https://github.com/' },
          repository: { full_name: 'seti/test', html_url: 'https://github.com/' },
          sender: { login: 'seti' },
        }),
      }),
    })
  },
})
