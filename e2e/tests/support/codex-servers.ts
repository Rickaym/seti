import type { Page } from '@playwright/test'
import type { AccessItem, TaskAccessView } from '@seti/shared'

const server = (name: string, unusable: string | null): AccessItem => ({
  kind: 'mcp',
  id: name,
  name,
  detail: 'configured',
  default_enabled: true,
  override: null,
  enabled: true,
  jump_for: [],
  missing_key: [],
  in_set: false,
  session: null,
  unusable,
})

/** Serves a Codex agent's access with one MCP server it can use and one over SSE it cannot. */
export async function serveCodexServers(page: Page, id: string): Promise<void> {
  await page.route(`**/api/tasks/${id}/access`, async (route) => {
    const response = await route.fetch()
    const body = (await response.json()) as { data: TaskAccessView }
    const items = [
      ...body.data.items.filter((item) => item.kind !== 'mcp'),
      server('docs', null),
      server('events', 'Codex agents cannot use SSE servers.'),
    ]
    await route.fulfill({ response, json: { ...body, data: { ...body.data, items } } })
  })
}
