import type { Locator, Page } from '@playwright/test'
import type { CapabilitiesSnapshot, McpAuthStart, McpServer } from '@seti/shared'
import { paths } from './env.js'

const server = (name: string, status: McpServer['status'], signIn: McpServer['sign_in']): McpServer => ({
  name,
  status,
  scope: 'user',
  source: null,
  transport: { type: 'http', target: `https://${name}.example.com/mcp` },
  connector_id: null,
  server_version: null,
  error: null,
  tools: [],
  sign_in: signIn,
})

/** As Seti serves them: tracker has a client ID and no token, wiki a token, search no client ID. */
const SNAPSHOT: CapabilitiesSnapshot = {
  cwd: paths.checkout,
  probed_at: '2026-10-04T09:00:00.000Z',
  duration_ms: 900,
  pending_timed_out: false,
  account: { email: null, organization: null, subscription_type: null, api_provider: null },
  servers: [
    server('tracker', 'needs-auth', 'required'),
    server('wiki', 'connected', 'again'),
    server('search', 'connected', 'none'),
  ],
  skill_groups: [],
  builtin_commands: [],
  subagents: [],
  models: [],
}

export async function mockSignInServers(page: Page): Promise<void> {
  await page.route(/\/api\/capabilities(\/refresh)?(\?.*)?$/, async (route) =>
    route.fulfill({ json: { data: SNAPSHOT, meta: {} } }),
  )
  const started: McpAuthStart = {
    session_id: 'e2e-sign-in',
    authorization_url: 'https://auth.example.com/authorize',
    callback_expected: false,
  }
  await page.route(/\/api\/mcp\/[^/]+\/auth\/start$/, async (route) =>
    route.fulfill({ json: { data: started, meta: {} } }),
  )
}

export const serverRow = (page: Page, name: string): Locator =>
  page
    .getByRole('main')
    .getByRole('listitem')
    .filter({ has: page.getByText(name, { exact: true }) })
