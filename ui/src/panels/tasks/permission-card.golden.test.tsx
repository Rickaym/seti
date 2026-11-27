import type { PermissionRequest, RequestPr } from '@seti/shared'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { PermissionCard } from '@/panels/tasks/PermissionRequests'

vi.mock('@/hooks/useTasks', () => ({ useTasks: () => ({ tasks: [] }), refreshTasks: () => undefined }))
vi.mock('@/panels/tasks/SlackLookUp', () => ({ SlackLookUp: () => null }))

const COMMAND = 'gh pr merge 2136 -R acme/tool --merge 2>&1 | tail -2'

const REQUEST: PermissionRequest = {
  id: 'request-1',
  task_id: 'task-1',
  tool_name: 'Bash',
  call_id: null,
  kind: 'tool',
  summary: COMMAND,
  description: null,
  input: JSON.stringify({ command: COMMAND, description: 'Merge the lease fix' }, null, 2),
  reason: 'Merge the lease fix',
  suggestions: [`Bash(${COMMAND})`],
  editable: false,
  prs: [],
  state: 'pending',
  message: null,
  edited: [],
  created_at: '2026-11-26T09:00:00.000Z',
  decided_at: null,
  timeout_at: null,
  timed_out: false,
}

const pr = (
  number: number,
  title: string | null,
  ci: RequestPr['ci'],
  state: RequestPr['state'] = null,
): RequestPr => ({
  url: `https://github.com/acme/tool/pull/${String(number)}`,
  repo: 'acme/tool',
  number,
  title,
  ci,
  state,
})

const card = (request: PermissionRequest) =>
  renderToStaticMarkup(
    <TooltipProvider>
      <PermissionCard request={request} onAnswered={() => undefined} />
    </TooltipProvider>,
  )

describe('the permission card', () => {
  it('draws a card whose command names no PR as before', async () => {
    await expect(`${JSON.stringify({ card: card(REQUEST) }, null, 2)}\n`).toMatchFileSnapshot(
      './permission-card.golden.json',
    )
  })

  it('adds one line per PR the command names, three at most, then how many more', () => {
    const prs = [pr(2136, 'Fix lease renewal after TTL', 'success'), pr(2137, null, null), pr(1, 'a', 'failure')]
    const html = card({ ...REQUEST, prs: [...prs, pr(2, 'b', 'pending'), pr(3, null, null)] })
    expect(html).toContain('aria-label="Pull request tool#2136"')
    expect(html).toContain('Fix lease renewal after TTL')
    expect(html).toContain('ci pass')
    expect(html).toContain('href="https://github.com/acme/tool/pull/2136" target="_blank" rel="noreferrer"')
    expect(html).toContain('aria-label="Pull request tool#1"')
    expect(html).not.toContain('Pull request tool#2"')
    expect(html).toContain('>+2</span>')
    expect(card({ ...REQUEST, prs })).not.toContain('>+')
  })

  it('offers no Always when an ask rule held the call', () => {
    const html = card({ ...REQUEST, suggestions: [] })
    expect(html).not.toContain('Always')
    expect(card(REQUEST)).toContain('Always adds')
  })

  it("puts the agent's description first, then the command, then Seti's reason and the PRs", async () => {
    const described = {
      ...REQUEST,
      description: 'Merge tool#2136',
      prs: [pr(2136, 'Fix lease renewal after TTL', 'success', 'merged')],
    }
    const html = card(described)
    const at = (text: string) => html.indexOf(text)
    expect(at('Merge tool#2136')).toBeGreaterThan(at('Allow Bash?'))
    expect(at('<code')).toBeGreaterThan(at('Merge tool#2136'))
    expect(at('Merge the lease fix')).toBeGreaterThan(at('<code'))
    expect(at('aria-label="Merged"')).toBeGreaterThan(at('Merge the lease fix'))
    await expect(`${JSON.stringify({ card: html }, null, 2)}\n`).toMatchFileSnapshot(
      './permission-card-description.golden.json',
    )
  })
})
