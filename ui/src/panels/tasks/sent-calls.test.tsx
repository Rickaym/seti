import type { PermissionRequest, WireRow } from '@seti/shared'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { ToolUseBlock } from '@/lib/transcript'
import { EditedLine } from '@/panels/tasks/EditedLine'
import { ToolCall } from '@/panels/tasks/ToolCall'
import { editedCallIds, SentCallsContext, sentCallsOf, type SentCall } from '@/panels/tasks/sent-calls'

const TOOL = 'mcp__chat__send_message'

const request = (over: Partial<PermissionRequest>): PermissionRequest => ({
  id: 'request-1',
  task_id: 'task-1',
  tool_name: TOOL,
  call_id: 'toolu_1',
  kind: 'review',
  summary: 'Deploy is dnoe',
  description: null,
  input: JSON.stringify({ channel: 'C1', text: 'Deploy is done' }, null, 2),
  reason: null,
  suggestions: [],
  editable: true,
  prs: [],
  state: 'allowed',
  message: null,
  edited: ['text'],
  created_at: '2026-11-27T10:00:00.000Z',
  decided_at: '2026-11-27T10:01:00.000Z',
  timeout_at: null,
  timed_out: false,
  ...over,
})

const mark = (edited: { fields: string[]; denied: boolean; tool?: string; call?: string }, id = 1): WireRow => ({
  id,
  task_id: 'task-1',
  outward: [],
  created_at: '2026-11-27T10:01:00.000Z',
  kind: 'seti',
  payload: { error: 'Edited text', edited },
})

const BLOCK: ToolUseBlock = {
  callId: 'toolu_1',
  kind: 'mcp',
  name: TOOL,
  input: { channel: 'C1', text: 'Deploy is dnoe' },
  mcp: { server: 'chat', tool: 'send_message' },
}

const SENT = new Map<string, SentCall>([['toolu_1', { input: { channel: 'C1', text: 'Deploy is done' } }]])

const row = (sent: ReadonlyMap<string, SentCall>) =>
  renderToStaticMarkup(
    <TooltipProvider>
      <SentCallsContext value={sent}>
        <ToolCall
          taskId="task-1"
          rowId={1}
          startedAt="2026-11-27T10:00:00.000Z"
          block={BLOCK}
          result={undefined}
          outward={false}
          inputTrimmed={false}
          running={false}
          background={undefined}
        />
      </SentCallsContext>
    </TooltipProvider>,
  )

describe('the calls the user edited and then allowed', () => {
  it('are named by the edit marks that kept a call id and were not denied', () => {
    const rows = [
      mark({ fields: ['text'], denied: false, tool: TOOL, call: 'toolu_1' }, 1),
      mark({ fields: ['text'], denied: true, tool: TOOL, call: 'toolu_2' }, 2),
      mark({ fields: ['text'], denied: false, tool: TOOL }, 3),
    ]
    expect(editedCallIds(rows)).toEqual(['toolu_1'])
  })

  it('take the input the call ran with from an allowed, edited request with the same id', () => {
    const sent = sentCallsOf([request({})], ['toolu_1'])
    expect(sent.get('toolu_1')).toEqual({ input: { channel: 'C1', text: 'Deploy is done' } })
  })

  it('leave out a denied, unedited, unlinked or cut-short request', () => {
    const requests = [
      request({ state: 'denied' }),
      request({ edited: [] }),
      request({ call_id: null }),
      request({ call_id: 'toolu_other' }),
      request({ input: '{\n  "text": "Deploy' }),
    ]
    expect(sentCallsOf(requests, ['toolu_1']).size).toBe(0)
  })
})

describe('an edited call row', () => {
  it('shows what was sent, marked edited, with the agent draft under it', () => {
    const html = row(SENT)
    expect(html).toContain('data-testid="tool-edited"')
    expect(html).toContain('data-testid="tool-draft"')
    const draftAt = html.indexOf('data-testid="tool-draft"')
    expect(html.indexOf('Deploy is done')).toBeLessThan(draftAt)
    expect(html.indexOf('Deploy is dnoe')).toBeGreaterThan(draftAt)
  })

  it('stays the agent draft, with no mark, without a linked request', () => {
    const html = row(new Map())
    expect(html).not.toContain('tool-edited')
    expect(html).not.toContain('tool-draft')
    expect(html).toContain('Deploy is dnoe')
    expect(html).not.toContain('Deploy is done')
  })

  it('has a mark that drops the draft clause only when the row shows what was sent', () => {
    const linked = { fields: ['text'], denied: false, tool: TOOL, call: 'toolu_1' }
    const sentLine = renderToStaticMarkup(
      <SentCallsContext value={SENT}>
        <EditedLine mark={linked} />
      </SentCallsContext>,
    )
    expect(sentLine).toContain('You edited the text before chat.send_message ran.</span>')
    const draftLine = renderToStaticMarkup(<EditedLine mark={linked} />)
    expect(draftLine).toContain('before chat.send_message ran. Above is the agent&#x27;s draft.')
  })
})
