import type { Page } from '@playwright/test'
import type { CapabilitiesSnapshot, McpServer, StoredRuntime } from '@seti/shared'
import { paths } from './env.js'

const server = (name: string, type: 'http' | 'sse', runtimes: StoredRuntime[]): McpServer => ({
  name,
  status: 'connected',
  scope: 'user',
  source: null,
  transport: { type, target: `https://${name}.example.com/mcp` },
  connector_id: null,
  server_version: null,
  error: null,
  tools: [],
  sign_in: 'none',
  runtimes,
})

/** A probe with one server every runtime can use and one only Claude Code can. */
const SNAPSHOT: CapabilitiesSnapshot = {
  cwd: paths.checkout,
  probed_at: '2026-10-04T09:00:00.000Z',
  duration_ms: 900,
  pending_timed_out: false,
  account: { email: null, organization: null, subscription_type: null, api_provider: null },
  servers: [server('docs', 'http', ['claude', 'codex']), server('events', 'sse', ['claude'])],
  skill_groups: [],
  builtin_commands: [],
  subagents: [],
  models: [],
}

/** Serves the probe above in place of Claude Code's. */
export async function mockTaggedServers(page: Page): Promise<void> {
  await page.route(/\/api\/capabilities(\/refresh)?(\?.*)?$/, async (route) =>
    route.fulfill({ json: { data: SNAPSHOT, meta: {} } }),
  )
}
