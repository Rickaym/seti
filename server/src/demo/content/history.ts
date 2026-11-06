import type { DemoRepo } from './cast.js'
import { Transcript } from './transcript.js'

/** A second workspace of agents with a month of turns and merged PRs, for the shipping metrics. */
export const FLEET_WORKSPACE = { id: '9e4a6c8d-0f2b-4d5e-8a7c-1b3d5f7a9c06', name: 'Platform' }

/** An agent of the fleet: when it worked, the MCP tools it called and the days its PRs merged. */
export interface FleetSeed {
  id: string
  title: string
  repo: DemoRepo
  color: string
  status: 'idle' | 'running'
  /** Days before now of its first and last turn. */
  from: number
  to: number
  turns: number
  prompts: readonly string[]
  /** MCP tools its turns call, in turn. */
  tools: readonly string[]
  /** Days before now each of its PRs merged. */
  merged: readonly number[]
}

export const FLEET: readonly FleetSeed[] = [
  {
    id: '5a1c7f20-6b8d-4c9e-8f1a-7c2e4b6d8f11',
    title: 'Ship partner webhooks v2',
    repo: 'acme/api',
    color: '#3baca6',
    status: 'idle',
    from: 27,
    to: 2,
    turns: 14,
    prompts: ['Sign webhook payloads with HMAC', 'Retry failed deliveries with backoff', 'Document the v2 events'],
    tools: ['mcp__linear__get_issue', 'mcp__github__create_pull_request'],
    merged: [2, 5, 10, 14, 20],
  },
  {
    id: '6b2d8a31-7c9e-4dae-9a2b-8d3f5c7e9a12',
    title: 'Cut the storefront bundle size',
    repo: 'acme/storefront',
    color: '#37a4d5',
    status: 'idle',
    from: 20,
    to: 1,
    turns: 11,
    prompts: ['Split the checkout route', 'Drop moment for date-fns', 'Lazy-load the image zoom'],
    tools: ['mcp__github__create_pull_request', 'mcp__sentry__search_issues'],
    merged: [1, 3, 4, 11],
  },
  {
    id: '7c3e9b42-8d0f-4ebf-8b3c-9e4a6d8f0b13',
    title: 'Sweep flaky tests nightly',
    repo: 'acme/storefront',
    color: '#7e74e1',
    status: 'running',
    from: 29,
    to: 0,
    turns: 22,
    prompts: ['Quarantine the flakes from last night', 'Fix the top flaky spec', 'Report the flake rate'],
    tools: ['mcp__github__list_workflow_runs', 'mcp__github__create_pull_request', 'mcp__linear__create_issue'],
    merged: [0, 1, 2, 6, 7, 8, 13, 16, 22, 26],
  },
  {
    id: '8d4fac53-9e1a-4fc0-9c4d-0f5b7e9a1c14',
    title: 'Rotate staging TLS certificates',
    repo: 'acme/infra',
    color: '#d08c2a',
    status: 'idle',
    from: 12,
    to: 3,
    turns: 6,
    prompts: ['Find certificates that expire this quarter', 'Rotate the staging ingress certificate'],
    tools: ['mcp__github__create_pull_request'],
    merged: [3, 12],
  },
  {
    id: '9e5abd64-0f2b-4ad1-8d5e-1a6c8f0b2d15',
    title: 'Translate the docs to German',
    repo: 'acme/docs',
    color: '#8f9a3a',
    status: 'idle',
    from: 19,
    to: 4,
    turns: 8,
    prompts: ['Translate the quickstart', 'Translate the webhooks guide', 'Check the glossary'],
    tools: ['mcp__notion__search', 'mcp__github__create_pull_request'],
    merged: [4, 12, 18],
  },
  {
    id: 'af6bce75-1a3c-4be2-9e6f-2b7d9a1c3e16',
    title: 'Audit API rate limits',
    repo: 'acme/api',
    color: '#c75b8a',
    status: 'idle',
    from: 9,
    to: 5,
    turns: 5,
    prompts: ['List the endpoints without a limit', 'Compare the limits with last month of traffic'],
    tools: ['mcp__grafana__query', 'mcp__sentry__search_issues'],
    merged: [],
  },
]

const BASE_MS = 95_000
const BASE_COST = 0.38

/** A turn per prompt in turn, each calling its MCP tool. */
export function fleetTranscript(seed: FleetSeed): Transcript {
  const transcript = new Transcript(seed.id.slice(0, 8))
  for (let n = 0; n < seed.turns; n++) {
    const prompt = seed.prompts[n % seed.prompts.length] ?? seed.title
    const tool = seed.tools[n % seed.tools.length] ?? 'mcp__github__create_pull_request'
    transcript
      .prompt(prompt)
      .tool(tool, { query: prompt }, 'ok')
      .say(`Done: ${prompt.toLowerCase()}.`)
      .ended(BASE_MS * (1 + (n % 4)), BASE_COST + (n % 5) * 0.21)
  }
  return transcript
}
