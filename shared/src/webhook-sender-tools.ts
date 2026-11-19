import { senderDefinition, type SenderDefinitionInput, type WebhookSender } from './webhook-senders.js'

/** The Standard Webhooks scheme, under the header names a producer uses. */
const standardWebhooks = (headers: { id: string; timestamp: string; signature: string }): SenderDefinitionInput => ({
  signature: {
    scheme: 'hmac',
    header: headers.signature,
    encoding: 'base64',
    prefix: 'v1,',
    separator: 'space',
    signed: '{id}.{timestamp}.{body}',
    key: 'base64',
  },
  timestamp: { in: 'header', name: headers.timestamp },
  id: { in: 'header', name: headers.id },
  event: { in: 'body', name: 'type' },
})

const STANDARD: WebhookSender = {
  id: 'standard-webhooks',
  title: 'Standard Webhooks',
  description: 'Any app that signs by the Standard Webhooks spec, with webhook-id, -timestamp and -signature.',
  icon: null,
  docs: 'https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md',
  secret_label: 'Signing secret',
  steps: [
    'In the app, add a webhook endpoint with the URL.',
    'Copy the signing secret it shows, which starts with whsec_, into Seti.',
  ],
  kinds: [],
  definition: senderDefinition.parse(
    standardWebhooks({ id: 'webhook-id', timestamp: 'webhook-timestamp', signature: 'webhook-signature' }),
  ),
}

const SVIX: WebhookSender = {
  id: 'svix',
  title: 'Svix',
  description: 'Any app that sends its webhooks through Svix, with svix-id, svix-timestamp and svix-signature.',
  icon: null,
  docs: 'https://docs.svix.com/receiving/verifying-payloads/how-manual',
  secret_label: 'Signing secret',
  steps: [
    "In the app's webhook settings, add an endpoint with the URL.",
    "Copy the endpoint's signing secret, which starts with whsec_, into Seti.",
  ],
  kinds: [],
  definition: senderDefinition.parse({
    ...standardWebhooks({ id: 'svix-id', timestamp: 'svix-timestamp', signature: 'svix-signature' }),
    event: { in: 'body', name: 'event_type' },
  }),
}

const GRAFANA: WebhookSender = {
  id: 'grafana',
  title: 'Grafana',
  description: 'Alerting notifications from a webhook contact point: firing and resolved alerts.',
  icon: null,
  docs: 'https://grafana.com/docs/grafana/latest/alerting/configure-notifications/manage-contact-points/integrations/webhook-notifier/',
  secret_label: 'Secret',
  steps: [
    'In Grafana, open Alerting, Contact points and add a contact point with the Webhook integration.',
    'Paste the URL; under HMAC Signature paste the secret from Seti as the Secret.',
    'Leave the signature header as it is and the Timestamp Header empty, then save.',
  ],
  kinds: ['firing', 'resolved'],
  definition: senderDefinition.parse({
    signature: { scheme: 'hmac', header: 'X-Grafana-Alerting-Signature' },
    secret: 'generated',
    event: { in: 'body', name: 'status' },
    title: ['title', 'alerts.0.labels.alertname'],
    link: ['externalURL', 'alerts.0.generatorURL'],
    detail: ['message'],
  }),
}

const CLOUDFLARE: WebhookSender = {
  id: 'cloudflare',
  title: 'Cloudflare',
  description: 'Cloudflare Notifications sent to a webhook destination.',
  icon: 'cloudflare',
  docs: 'https://developers.cloudflare.com/notifications/get-started/configure-webhooks/',
  secret_label: 'Secret',
  steps: [
    'In the Cloudflare dashboard, open Notifications, Destinations and create a webhook.',
    'Give it a name, paste the URL and paste the secret from Seti as the Secret.',
    'Choose Save and Test, then send notifications to this destination.',
  ],
  kinds: [],
  definition: senderDefinition.parse({
    signature: { scheme: 'token', header: 'cf-webhook-auth' },
    secret: 'generated',
    event: { in: 'body', name: 'alert_type' },
    title: ['name', 'policy_name', 'text'],
    detail: ['text'],
  }),
}

/** An automation tool signs nothing: it sends the secret in a header the user adds to the step. */
const tokenHeader = (): SenderDefinitionInput => ({
  signature: { scheme: 'token', header: 'X-Webhook-Token' },
  secret: 'generated',
  event: { in: 'body', name: 'event' },
  title: ['title', 'text', 'message'],
  link: ['url', 'link'],
  detail: ['message', 'text'],
})

const ZAPIER: WebhookSender = {
  id: 'zapier',
  title: 'Zapier',
  description: 'A Webhooks by Zapier POST step that sends a secret header instead of signing.',
  icon: null,
  docs: 'https://help.zapier.com/hc/en-us/articles/8496326446989-Send-webhooks-in-Zaps',
  secret_label: 'Header value',
  steps: [
    'In the Zap, add a Webhooks by Zapier action with the POST event.',
    'Paste the URL, set Payload Type to JSON and fill Data with event, title and url fields.',
    'Under Headers add X-Webhook-Token with the secret from Seti.',
  ],
  kinds: [],
  definition: senderDefinition.parse(tokenHeader()),
}

const MAKE: WebhookSender = {
  id: 'make',
  title: 'Make',
  description: 'An HTTP "Make a request" module that sends a secret header instead of signing.',
  icon: null,
  docs: 'https://apps.make.com/http',
  secret_label: 'Header value',
  steps: [
    'In the scenario, add the HTTP module Make a request with the POST method and the URL.',
    'Set the body content type to application/JSON, with event, title and url fields.',
    'Under Headers add X-Webhook-Token with the secret from Seti.',
  ],
  kinds: [],
  definition: senderDefinition.parse(tokenHeader()),
}

/** Senders that are tools or shared schemes rather than one product's events. */
export const WEBHOOK_TOOL_SENDERS: readonly WebhookSender[] = [CLOUDFLARE, GRAFANA, MAKE, STANDARD, SVIX, ZAPIER]
