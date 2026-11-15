import type { McpConnector, McpConnectorField } from '@seti/shared'

interface Common {
  name: string
  title: string
  description: string
  url?: string
  plugin?: string
  header?: Pick<McpConnectorField, 'key' | 'description'>
  /** A Google Workspace server, which signs in with the user's own Google Cloud OAuth client. */
  google?: true
}

const GOOGLE_NOTE =
  'Google asks for your own OAuth client: create a Desktop app client in Google Cloud, enable this ' +
  "product's MCP API, then enter the client ID and secret."

/** Remote servers their vendors run, all signing in with OAuth unless a header or note says so. */
const COMMON: readonly Common[] = [
  {
    name: 'slack',
    title: 'Slack',
    description: 'Search, read and send messages, canvases and lists.',
    plugin: 'slack@claude-plugins-official',
  },
  {
    name: 'gmail',
    title: 'Gmail',
    description: 'Search, read and draft email.',
    url: 'https://gmailmcp.googleapis.com/mcp/v1',
    google: true,
  },
  {
    name: 'google-drive',
    title: 'Google Drive',
    description: 'Find and read Docs, Sheets and other files.',
    url: 'https://drivemcp.googleapis.com/mcp/v1',
    google: true,
  },
  {
    name: 'google-calendar',
    title: 'Google Calendar',
    description: 'Read and schedule events.',
    url: 'https://calendarmcp.googleapis.com/mcp/v1',
    google: true,
  },
  {
    name: 'wispr-flow',
    title: 'Wispr Flow',
    description: 'Meetings, notes and transcripts.',
    url: 'https://api.wisprflow.ai/connect/mcp',
  },
  {
    name: 'supabase',
    title: 'Supabase',
    description: 'Projects, databases, migrations and edge functions.',
    url: 'https://mcp.supabase.com/mcp',
  },
  {
    name: 'notion',
    title: 'Notion',
    description: 'Search and edit pages and databases.',
    url: 'https://mcp.notion.com/mcp',
  },
  { name: 'linear', title: 'Linear', description: 'Issues, projects and cycles.', url: 'https://mcp.linear.app/mcp' },
  {
    name: 'github',
    title: 'GitHub',
    description: 'Repositories, issues, pull requests and Actions.',
    url: 'https://api.githubcopilot.com/mcp/',
    header: { key: 'Authorization', description: 'Bearer and a personal access token' },
  },
  { name: 'sentry', title: 'Sentry', description: 'Issues, events and releases.', url: 'https://mcp.sentry.dev/mcp' },
  {
    name: 'atlassian',
    title: 'Atlassian',
    description: 'Jira issues and Confluence pages.',
    url: 'https://mcp.atlassian.com/v1/mcp',
  },
  {
    name: 'figma',
    title: 'Figma',
    description: 'Designs, components and variables.',
    url: 'https://mcp.figma.com/mcp',
  },
  { name: 'vercel', title: 'Vercel', description: 'Projects, deployments and logs.', url: 'https://mcp.vercel.com' },
  { name: 'stripe', title: 'Stripe', description: 'Customers, payments and products.', url: 'https://mcp.stripe.com' },
  { name: 'clickup', title: 'ClickUp', description: 'Tasks, lists and docs.', url: 'https://mcp.clickup.com/mcp' },
  {
    name: 'fathom',
    title: 'Fathom',
    description: 'Meeting recordings and summaries.',
    url: 'https://api.fathom.ai/mcp',
  },
  { name: 'granola', title: 'Granola', description: 'Meeting notes.', url: 'https://mcp.granola.ai/mcp' },
  {
    name: 'posthog',
    title: 'PostHog',
    description: 'Analytics, flags and errors.',
    url: 'https://mcp.posthog.com/mcp',
  },
  { name: 'canva', title: 'Canva', description: 'Designs and brand assets.', url: 'https://mcp.canva.com/mcp' },
  {
    name: 'intercom',
    title: 'Intercom',
    description: 'Conversations and contacts.',
    url: 'https://mcp.intercom.com/mcp',
  },
  { name: 'monday', title: 'monday.com', description: 'Boards and items.', url: 'https://mcp.monday.com/mcp' },
  {
    name: 'airtable',
    title: 'Airtable',
    description: 'Bases, tables and records.',
    url: 'https://mcp.airtable.com/mcp',
  },
  { name: 'neon', title: 'Neon', description: 'Serverless Postgres projects.', url: 'https://mcp.neon.tech/mcp' },
  {
    name: 'cloudflare',
    title: 'Cloudflare',
    description: 'Workers, KV, R2 and D1.',
    url: 'https://bindings.mcp.cloudflare.com/mcp',
  },
  { name: 'paypal', title: 'PayPal', description: 'Invoices, orders and payments.', url: 'https://mcp.paypal.com/mcp' },
  { name: 'webflow', title: 'Webflow', description: 'Sites, pages and CMS.', url: 'https://mcp.webflow.com/mcp' },
  { name: 'attio', title: 'Attio', description: 'CRM records and lists.', url: 'https://mcp.attio.com/mcp' },
  {
    name: 'honeycomb',
    title: 'Honeycomb',
    description: 'Queries, traces and SLOs.',
    url: 'https://mcp.honeycomb.io/mcp',
  },
  { name: 'prisma', title: 'Prisma', description: 'Prisma Postgres databases.', url: 'https://mcp.prisma.io/mcp' },
]

const GOOGLE_PORT = 8765

function toConnector(entry: Common): McpConnector {
  const header = entry.header === undefined ? [] : [{ ...entry.header, required: true, secret: true, value: '' }]
  return {
    id: `common:${entry.name}`,
    name: entry.name,
    title: entry.title,
    description: entry.description,
    source: 'common',
    transport: 'http',
    url: entry.url ?? '',
    command: '',
    args: [],
    fields: header,
    oauth: entry.google ? { own_client: true, callback_port: GOOGLE_PORT } : null,
    plugin: entry.plugin ?? null,
    homepage: null,
    note: entry.google ? GOOGLE_NOTE : '',
  }
}

const CONNECTORS = COMMON.map(toConnector)

const matches = (connector: McpConnector, words: string[]) => {
  const text = `${connector.title} ${connector.name} ${connector.description}`.toLowerCase()
  return words.every((word) => text.includes(word))
}

/** The common connectors whose title, name or description hold every word of the query. */
export function commonConnectors(query: string): McpConnector[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  return CONNECTORS.filter((connector) => matches(connector, words))
}
