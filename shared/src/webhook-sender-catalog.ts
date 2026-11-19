import { WEBHOOK_TOOL_SENDERS } from './webhook-sender-tools.js'
import { senderDefinition, type WebhookSender } from './webhook-senders.js'

const LINEAR: WebhookSender = {
  id: 'linear',
  title: 'Linear',
  description: 'Issues, comments, projects, cycles and other changes in a Linear workspace.',
  icon: 'linear',
  docs: 'https://linear.app/developers/webhooks',
  secret_label: 'Signing secret',
  steps: [
    'In Linear, open Settings, API and choose New webhook.',
    'Paste the URL, give it a label and tick what it reports.',
    "Copy the signing secret from the webhook's detail page into Seti.",
  ],
  kinds: ['issue', 'issue.create', 'issue.update', 'issue.remove', 'comment', 'comment.create', 'project', 'cycle'],
  definition: senderDefinition.parse({
    signature: { scheme: 'hmac', header: 'Linear-Signature' },
    timestamp: { in: 'body', name: 'webhookTimestamp' },
    id: { in: 'header', name: 'Linear-Delivery' },
    max_age_s: 60,
    event: { in: 'body', name: 'type' },
    action: 'action',
    title: ['data.title', 'data.name', 'data.body'],
    link: ['url'],
    detail: ['data.description', 'data.body'],
  }),
}

const STRIPE: WebhookSender = {
  id: 'stripe',
  title: 'Stripe',
  description: 'Payments, invoices, subscriptions and other events of a Stripe account.',
  icon: 'stripe',
  docs: 'https://docs.stripe.com/webhooks',
  secret_label: 'Signing secret',
  steps: [
    'In the Stripe Dashboard, open Webhooks in Workbench and choose Create an event destination.',
    'Pick the events, choose Webhook endpoint and paste the URL as the Endpoint URL.',
    'On the destination page, Reveal secret and paste it into Seti.',
  ],
  kinds: ['payment_intent.succeeded', 'payment_intent.payment_failed', 'invoice.paid', 'charge.refunded'],
  definition: senderDefinition.parse({
    signature: {
      scheme: 'hmac',
      header: 'Stripe-Signature',
      prefix: 'v1=',
      separator: 'comma',
      signed: '{timestamp}.{body}',
    },
    timestamp: { in: 'signature', name: 't' },
    id: { in: 'body', name: 'id' },
    event: { in: 'body', name: 'type' },
  }),
}

const SLACK: WebhookSender = {
  id: 'slack',
  title: 'Slack',
  description: "Events API deliveries of a Slack app: messages, reactions, joins and the rest of the app's events.",
  icon: null,
  docs: 'https://docs.slack.dev/authentication/verifying-requests-from-slack',
  secret_label: 'Signing Secret',
  steps: [
    'At api.slack.com/apps, open the app; copy the Signing Secret from Basic Information into Seti.',
    'Open Event Subscriptions, turn it on and paste the URL as the request URL.',
    'Pick the workspace or bot events to send and save.',
  ],
  kinds: ['message', 'reaction_added', 'reaction_removed', 'team_join', 'app_mention'],
  definition: senderDefinition.parse({
    signature: { scheme: 'hmac', header: 'X-Slack-Signature', prefix: 'v0=', signed: 'v0:{timestamp}:{body}' },
    timestamp: { in: 'header', name: 'X-Slack-Request-Timestamp' },
    id: { in: 'body', name: 'event_id' },
    event: { in: 'body', name: 'event.type' },
    action: 'event.subtype',
    title: ['event.text'],
    detail: ['event.text'],
    handshake: { path: 'type', equals: 'url_verification', echo: 'challenge' },
  }),
}

const GITLAB: WebhookSender = {
  id: 'gitlab',
  title: 'GitLab',
  description: 'Project or group webhooks: pushes, merge requests, issues, pipelines and releases.',
  icon: null,
  docs: 'https://docs.gitlab.com/user/project/integrations/webhooks/',
  secret_label: 'Signing token',
  steps: [
    'In the GitLab project or group, open Settings, Webhooks and choose Add new webhook.',
    'Paste the URL, choose Generate signing token and copy the token into Seti.',
    'Tick the triggers and choose Add webhook.',
  ],
  kinds: ['push', 'merge_request', 'merge_request.open', 'merge_request.merge', 'issue', 'note', 'pipeline', 'release'],
  definition: senderDefinition.parse({
    signature: {
      scheme: 'hmac',
      header: 'webhook-signature',
      encoding: 'base64',
      prefix: 'v1,',
      separator: 'space',
      signed: '{id}.{timestamp}.{body}',
      key: 'base64',
    },
    timestamp: { in: 'header', name: 'webhook-timestamp' },
    id: { in: 'header', name: 'webhook-id' },
    event: { in: 'body', name: 'object_kind' },
    action: 'object_attributes.action',
    title: ['object_attributes.title', 'object_attributes.name', 'name', 'ref'],
    link: ['object_attributes.url', 'url', 'project.web_url'],
    detail: ['object_attributes.description', 'object_attributes.note'],
  }),
}

const hubSignature = { scheme: 'hmac', header: 'X-Hub-Signature', prefix: 'sha256=' } as const

const JIRA: WebhookSender = {
  id: 'jira',
  title: 'Jira',
  description: 'Jira Cloud webhooks: issues, comments, sprints and versions.',
  icon: 'jira',
  docs: 'https://developer.atlassian.com/cloud/jira/platform/webhooks/',
  secret_label: 'Secret',
  steps: [
    'In Jira, open Settings, System and, under Advanced, WebHooks.',
    'Create a webhook with the URL and paste the secret from Seti as its secret.',
    'Pick the events to send and save.',
  ],
  kinds: ['jira:issue_created', 'jira:issue_updated', 'jira:issue_deleted', 'comment_created', 'sprint_started'],
  definition: senderDefinition.parse({
    signature: hubSignature,
    id: { in: 'header', name: 'X-Atlassian-Webhook-Identifier' },
    secret: 'generated',
    event: { in: 'body', name: 'webhookEvent' },
    title: ['issue.fields.summary', 'issue.key'],
    detail: ['comment.body'],
  }),
}

const BITBUCKET: WebhookSender = {
  id: 'bitbucket',
  title: 'Bitbucket',
  description: 'Bitbucket Cloud repository webhooks: pushes, pull requests and builds.',
  icon: 'atlassian',
  docs: 'https://support.atlassian.com/bitbucket-cloud/docs/manage-webhooks/',
  secret_label: 'Secret',
  steps: [
    'In the Bitbucket repository, open Settings and, under Workflow, Webhooks, then Add webhook.',
    'Give it a title, paste the URL and paste the secret from Seti as the Secret.',
    'Choose the triggers and save.',
  ],
  kinds: ['repo:push', 'pullrequest:created', 'pullrequest:fulfilled', 'pullrequest:rejected'],
  definition: senderDefinition.parse({
    signature: hubSignature,
    id: { in: 'header', name: 'X-Request-UUID' },
    secret: 'generated',
    event: { in: 'header', name: 'X-Event-Key' },
    title: ['pullrequest.title', 'repository.full_name'],
    link: ['pullrequest.links.html.href', 'repository.links.html.href'],
    detail: ['pullrequest.description'],
  }),
}

const VERCEL: WebhookSender = {
  id: 'vercel',
  title: 'Vercel',
  description: 'Deployments, projects and domains of a Vercel team.',
  icon: 'vercel',
  docs: 'https://vercel.com/docs/webhooks/webhooks-api',
  secret_label: 'Secret key',
  steps: [
    'In the Vercel team, open Settings, Webhooks.',
    'Pick the events and projects, paste the URL and choose Create Webhook.',
    'Copy the secret key from the Webhook Created dialog into Seti; Vercel shows it once.',
  ],
  kinds: ['deployment.created', 'deployment.succeeded', 'deployment.error', 'deployment.canceled', 'project.created'],
  definition: senderDefinition.parse({
    signature: { scheme: 'hmac', header: 'x-vercel-signature', algorithm: 'sha1' },
    id: { in: 'body', name: 'id' },
    event: { in: 'body', name: 'type' },
    title: ['payload.deployment.name', 'payload.project.name'],
    link: ['payload.links.deployment', 'payload.links.project'],
  }),
}

const SHOPIFY: WebhookSender = {
  id: 'shopify',
  title: 'Shopify',
  description: 'Store events such as orders and product changes, by topic.',
  icon: null,
  docs: 'https://shopify.dev/docs/apps/build/webhooks/subscribe/https',
  secret_label: 'Client secret',
  steps: [
    'In the Shopify admin, open Settings, Notifications, Webhooks and choose Create webhook.',
    'Pick the event, the JSON format and paste the URL.',
    "Paste the secret Shopify signs with into Seti: the app's client secret.",
  ],
  kinds: ['orders/create', 'products/create', 'products/update'],
  definition: senderDefinition.parse({
    signature: { scheme: 'hmac', header: 'X-Shopify-Hmac-Sha256', encoding: 'base64' },
    id: { in: 'header', name: 'X-Shopify-Webhook-Id' },
    event: { in: 'header', name: 'X-Shopify-Topic' },
    title: ['title', 'name'],
  }),
}

const PAGERDUTY: WebhookSender = {
  id: 'pagerduty',
  title: 'PagerDuty',
  description: 'Generic Webhooks (v3): incidents triggered, acknowledged, escalated and resolved.',
  icon: 'pagerduty',
  docs: 'https://docs.pagerduty.com/developer/verifying-webhook-signatures',
  secret_label: 'Signing secret',
  steps: [
    'In PagerDuty, open Integrations, Generic Webhooks (v3) and choose New Webhook.',
    'Paste the URL as the Webhook URL, pick the event subscription and choose Add Webhook.',
    'Copy the secret PagerDuty shows after creating it into Seti.',
  ],
  kinds: ['incident.triggered', 'incident.acknowledged', 'incident.resolved', 'incident.escalated', 'pagey.ping'],
  definition: senderDefinition.parse({
    signature: { scheme: 'hmac', header: 'X-PagerDuty-Signature', prefix: 'v1=', separator: 'comma' },
    id: { in: 'body', name: 'event.id' },
    event: { in: 'body', name: 'event.event_type' },
    title: ['event.data.title', 'event.data.summary'],
    link: ['event.data.html_url'],
  }),
}

/** The apps Seti verifies without a mod, Linear first, then by name; each is data alone. */
export const WEBHOOK_SENDERS: readonly WebhookSender[] = [
  LINEAR,
  ...[BITBUCKET, GITLAB, JIRA, PAGERDUTY, SHOPIFY, SLACK, STRIPE, VERCEL, ...WEBHOOK_TOOL_SENDERS].sort((a, b) =>
    a.title.localeCompare(b.title),
  ),
]

const BY_ID: ReadonlyMap<string, WebhookSender> = new Map(WEBHOOK_SENDERS.map((sender) => [sender.id, sender]))

/** The catalog sender a source id names, if any. */
export const webhookSenderById = (id: string): WebhookSender | undefined => BY_ID.get(id)
