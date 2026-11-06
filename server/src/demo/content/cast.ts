import type { Transcript } from './transcript.js'
import {
  cartTranscript,
  checkoutTranscript,
  guideTranscript,
  INFRA_COMMAND,
  infraTranscript,
  ordersTranscript,
} from './transcripts.js'

/**
 * The fictional Acme team the demo and the README screenshots show: its repos, agents, group
 * chat and EA chat. Times are minutes before the moment the data is seeded for.
 */
export const REPOS = ['acme/storefront', 'acme/api', 'acme/infra', 'acme/docs'] as const

export type DemoRepo = (typeof REPOS)[number]

export const REPO_IDS: Record<DemoRepo, string> = {
  'acme/storefront': '5a0c2e4f-6b8d-4f1a-8c3e-7d9f1b3c5e01',
  'acme/api': '6b1d3f5a-7c9e-4a2b-9d4f-8e0a2c4d6f02',
  'acme/infra': '7c2e4a6b-8d0f-4b3c-8e5a-9f1b3d5e7a03',
  'acme/docs': '8d3f5b7c-9e1a-4c4d-9f6b-0a2c4e6f8b04',
}

export const AGENTS = {
  checkout: '0b7f5a52-1c3e-4d7a-9f2b-2d1c8a6e4f01',
  orders: '1c8e6b63-2d4f-4e8b-8a3c-3e2d9b7f5a02',
  infra: '2d9f7c74-3e5a-4f9c-9b4d-4f3e8c6a6b03',
  cart: '3e8a6d85-4f6b-4a8d-8c5e-5a4f9d7b7c04',
  guide: '4f9b7e96-5a7c-4b9e-9d6f-6b5a8e6c8d05',
} as const

export const PR_URL = 'https://github.com/acme/storefront/pull/482'

export { INFRA_COMMAND }

export interface AgentSeed {
  id: string
  title: string
  repo: DemoRepo
  status: 'idle' | 'running'
  transcript: Transcript
  /** When the first and the last rows were written, in minutes before now. */
  started: number
  ended: number
  extra: Record<string, string | number | boolean>
}

export const agentSeeds = (): AgentSeed[] => [
  {
    id: AGENTS.checkout,
    title: 'Retry card captures on gateway timeouts',
    repo: 'acme/storefront',
    status: 'running',
    transcript: checkoutTranscript(),
    started: 18,
    ended: 2,
    extra: { color: '#5488ec' },
  },
  {
    id: AGENTS.orders,
    title: 'Paginate the orders endpoint',
    repo: 'acme/api',
    status: 'running',
    transcript: ordersTranscript(),
    started: 9,
    ended: 1,
    extra: { color: '#4eb068' },
  },
  {
    id: AGENTS.infra,
    title: 'Upgrade staging Postgres to 17',
    repo: 'acme/infra',
    status: 'running',
    transcript: infraTranscript(),
    started: 6,
    ended: 1,
    extra: { color: '#e77f3e', blocked: `Asks to use Bash: ${INFRA_COMMAND}` },
  },
  {
    id: AGENTS.cart,
    title: 'Fix the flaky cart test',
    repo: 'acme/storefront',
    status: 'idle',
    transcript: cartTranscript(),
    started: 11,
    ended: 4,
    extra: { color: '#b066da', asking: true, unseen: true },
  },
  {
    id: AGENTS.guide,
    title: 'Write the v2 migration guide',
    repo: 'acme/docs',
    status: 'idle',
    transcript: guideTranscript(),
    started: 52,
    ended: 47,
    extra: { color: '#e05b9e' },
  },
]

export const GUIDE_MARKDOWN = `# Migrating to API v2

API v2 pages every list endpoint and returns money as integer minor units. v1 keeps working
until **30 June 2027**.

## What changes

| Area | v1 | v2 |
| --- | --- | --- |
| Lists | All at once | 50 a page |
| Money | \`"42.00"\` | \`4200\` cents |
| Errors | Text | Problem JSON |

## Steps

1. Send \`Accept-Version: 2\` on one endpoint and compare the responses.
2. Follow \`next_cursor\` until it is \`null\` instead of reading one response.
3. Divide amounts by 100 for display, using the \`currency\` field.

\`\`\`ts
let cursor: string | null = null
do {
  const page = await acme.orders.list({ cursor, limit: 50 })
  orders.push(...page.data)
  cursor = page.next_cursor
} while (cursor !== null)
\`\`\`

> Questions go to the partner channel; we answer within one working day.
`

export const TEAM_HANDLES = { checkout: 'checkout', orders: 'orders', infra: 'infra', cart: 'cart' } as const

type Handle = keyof typeof TEAM_HANDLES

/** A group chat line: who wrote it, the agents it mentions and how many minutes ago. */
export interface TeamLine {
  kind: 'user' | 'task' | 'ea'
  handle: Handle | null
  text: string
  mentions: Handle[]
  ago: number
}

export const TEAM_CHAT: TeamLine[] = [
  {
    kind: 'user',
    handle: null,
    text: '@orders is the v2 orders endpoint safe to deploy on Thursday?',
    mentions: ['orders'],
    ago: 14,
  },
  {
    kind: 'task',
    handle: 'orders',
    text: 'Yes, once the v1 client check finishes. Pages are opt-in, so v1 callers see no change.',
    mentions: [],
    ago: 13,
  },
  {
    kind: 'task',
    handle: 'checkout',
    text: '@orders checkout reads orders with `limit=500`. Will that still return everything?',
    mentions: ['orders'],
    ago: 11,
  },
  {
    kind: 'task',
    handle: 'orders',
    text: '@checkout v1 keeps the old shape. On v2 follow `next_cursor`.',
    mentions: ['checkout'],
    ago: 10,
  },
  {
    kind: 'ea',
    handle: null,
    text: 'Noted for the release checklist: checkout moves to v2 pages after Thursday.',
    mentions: [],
    ago: 9,
  },
]

/** The EA's chat: a status question answered with a tool call and a short summary. */
export const EA_CHAT = [
  { role: 'user', content: 'What needs me right now?' },
  {
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'list_tasks', arguments: '{"needs_you":true}' } }],
  },
  { role: 'tool', tool_call_id: 'c1', content: '"2 agents need you"' },
  {
    role: 'assistant',
    content:
      'Two agents:\n\n- **Upgrade staging Postgres to 17** waits on you to allow `terraform apply`. The plan changes one resource in place.\n- **Fix the flaky cart test** asks which fix you want: wait in the test, or render the badge once the currency loads.',
  },
  { role: 'user', content: 'Tell the cart agent to take the second fix.' },
  {
    role: 'assistant',
    content: 'Sent. The cart agent is rendering the badge once the currency is known, and will open a PR.',
  },
] as const

/** Webhook channels the EA follows, each with the events already delivered to it. */
export const CHANNELS = [
  {
    name: 'Storefront deploys',
    preset: 'generic',
    events: ['Deploy 2026.10.27-3 reached production', 'Deploy 2026.10.27-2 rolled back: health check failed'],
  },
  { name: 'API alerts', preset: 'generic', events: ['p95 latency on GET /v2/orders above 800 ms'] },
] as const
