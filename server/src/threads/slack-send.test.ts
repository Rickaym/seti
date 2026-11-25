import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { projectClaude } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { createSlackSendWatcher } from './slack-send.js'

const SEND = 'mcp__plugin_slack_slack__slack_send_message'
const LINK = 'https://acme.slack.com/archives/C0PROJ1234/p1700000000000100'
const REPLY_LINK =
  'https://acme.slack.com/archives/C0PROJ1234/p1700000050000200?thread_ts=1700000000.000100&cid=C0PROJ1234'

const toolUse = (id: string, name: string, input: unknown) =>
  ({
    type: 'assistant',
    parent_tool_use_id: null,
    message: { content: [{ type: 'tool_use', id, name, input }] },
  }) as unknown as SDKMessage

const toolResult = (id: string, content: string, isError = false) =>
  ({
    type: 'user',
    parent_tool_use_id: null,
    message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] },
  }) as unknown as SDKMessage

/** The messages a fresh watcher reports for one call and its result. */
function sent(name: string, input: unknown, result: string, isError = false) {
  const watch = createSlackSendWatcher()
  watch('t', projectClaude(toolUse('c1', name, input)))
  return watch('t', projectClaude(toolResult('c1', result, isError)))
}

describe('createSlackSendWatcher', () => {
  it('follows a new message from the link the Slack MCP server returns', () => {
    expect(sent(SEND, { channel_id: 'C0PROJ1234', message: 'hi' }, `Message sent: ${LINK}`)).toEqual([
      {
        service: 'slack',
        space: 'acme',
        container: 'C0PROJ1234',
        thread: '1700000000.000100',
        message: '1700000000.000100',
        url: LINK,
      },
    ])
  })

  it('reads the link in the JSON answer the Slack MCP server gives, slashes escaped', () => {
    const answer = JSON.stringify({
      message_link: LINK,
      message_context: { message_ts: '1700000000.000100', channel_id: 'C0PROJ1234' },
    }).replaceAll('/', '\\/')
    expect(sent(SEND, { channel_id: 'C0PROJ1234', message: 'hi' }, answer)).toEqual([
      {
        service: 'slack',
        space: 'acme',
        container: 'C0PROJ1234',
        thread: '1700000000.000100',
        message: '1700000000.000100',
        url: LINK,
      },
    ])
  })

  it('takes the thread of a reply from the link, else from the call', () => {
    const [fromLink] = sent(SEND, { channel_id: 'C0PROJ1234', message: 'hi' }, `Sent <${REPLY_LINK}>`)
    expect(fromLink).toMatchObject({ thread: '1700000000.000100', message: '1700000050.000200' })
    const input = { channel_id: 'C0PROJ1234', message: 'hi', thread_ts: '1700000000.000100' }
    const [fromInput] = sent(SEND, input, `Sent ${LINK.replace('p1700000000000100', 'p1700000050000200')}`)
    expect(fromInput).toMatchObject({ thread: '1700000000.000100', message: '1700000050.000200' })
  })

  it('reads a chat.postMessage answer printed by the shell', () => {
    const answer = JSON.stringify({ ok: true, channel: 'D0DIRECT99', ts: '1700000100.000300', message: { text: 'x' } })
    const curl = 'curl -s -X POST https://slack.com/api/chat.postMessage -d channel=U1 -d text=hi'
    expect(sent('Bash', { command: curl }, answer)).toEqual([
      {
        service: 'slack',
        space: '',
        container: 'D0DIRECT99',
        thread: '1700000100.000300',
        message: '1700000100.000300',
        url: null,
      },
    ])
    const reply = JSON.stringify({
      ok: true,
      channel: 'C0PROJ1234',
      ts: '1700000200.000400',
      message: { thread_ts: '1700000000.000100' },
    })
    expect(sent('Bash', { command: curl }, reply)[0]).toMatchObject({ thread: '1700000000.000100' })
  })

  it('follows nothing for failures, drafts, other tools or results without a channel and ts', () => {
    expect(sent(SEND, { channel_id: 'C0PROJ1234', message: 'hi' }, `Error ${LINK}`, true)).toEqual([])
    expect(sent('mcp__plugin_slack_slack__slack_send_message_draft', {}, LINK)).toEqual([])
    expect(sent('mcp__linear__save_comment', {}, LINK)).toEqual([])
    expect(sent(SEND, { channel_id: 'C0PROJ1234', message: 'hi' }, 'Message sent.')).toEqual([])
    const curl = 'curl https://slack.com/api/chat.postMessage'
    expect(sent('Bash', { command: curl }, JSON.stringify({ ok: false, error: 'not_in_channel' }))).toEqual([])
    expect(sent('Bash', { command: 'echo hi' }, LINK)).toEqual([])
  })
})
