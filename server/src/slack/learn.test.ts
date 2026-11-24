import { projectClaude, type ClaudeMessage } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { audit } from '../audit.js'
import { now } from '../db.js'
import { auditEvents } from '../store/audit.js'
import { slackNames } from '../store/slack-names.js'
import { quietTask } from '../threads/slack-test-kit.js'
import { slackSendSummary } from './destination.js'
import { learnSlackNames } from './learn.js'

const SEARCH = 'mcp__plugin_slack_slack__slack_search_channels'
const SEND = 'mcp__plugin_slack_slack__slack_send_message'

const use = (id: string, name: string, input: object) =>
  ({
    type: 'assistant',
    parent_tool_use_id: null,
    message: { content: [{ type: 'tool_use', id, name, input }] },
  }) as unknown as ClaudeMessage

const result = (id: string, content: string) =>
  ({
    type: 'user',
    parent_tool_use_id: null,
    message: { content: [{ type: 'tool_result', tool_use_id: id, content }] },
  }) as unknown as ClaudeMessage

describe('Slack names', () => {
  it("learns names from an agent's Slack tool results and corrects a rename", async () => {
    const task = await quietTask()
    const answer = (name: string) =>
      JSON.stringify({ results: `Name: #${name}\nPermalink: [link](https://acme.slack.com/archives/C0LEARN001)` })
    await learnSlackNames(task, projectClaude(use('s1', SEARCH, { query: 'rel' })))
    await learnSlackNames(task, projectClaude(result('s1', answer('release'))))
    expect(await slackNames.of(['C0LEARN001'])).toEqual(new Map([['C0LEARN001', 'release']]))
    await learnSlackNames(task, projectClaude(use('s2', SEARCH, { query: 'rel' })))
    await learnSlackNames(task, projectClaude(result('s2', answer('release-train'))))
    expect(await slackNames.of(['C0LEARN001'])).toEqual(new Map([['C0LEARN001', 'release-train']]))
  })

  it('names the destination of a send in its request, or says the name is not known', async () => {
    await slackNames.learn([{ id: 'C0DEPLOY02', kind: 'channel', name: 'deploys' }], 'test', now())
    expect(await slackSendSummary(SEND, { channel_id: 'C0DEPLOY02', message: 'Deploy done' })).toBe(
      'Send to #deploys: Deploy done',
    )
    expect(await slackSendSummary(SEND, { channel_id: 'C0UNKNOWN9', message: 'Hi' })).toBe(
      'Send to channel C0UNKNOWN9, name not known: Hi',
    )
    expect(await slackSendSummary('Bash', { command: 'ls' })).toBeNull()
  })

  it('shows the name in the outward audit summary and keeps the id in the detail', async () => {
    const task = await quietTask()
    await slackNames.learn([{ id: 'C0AUDIT001', kind: 'channel', name: 'audit-room' }], 'test', now())
    const events = projectClaude(use('a1', SEND, { channel_id: 'C0AUDIT001', message: 'Done' }))
    const ids = events.flatMap((event) => (event.type === 'tool.started' ? [event.call.callId] : []))
    await audit.outwardCalls(task, events, ids)
    const [event] = (await auditEvents.page({ kind: 'agent.outward', limit: 20 })).events.filter(
      (e) => e.subject_id === task,
    )
    expect(event?.summary).toContain('#audit-room')
    expect(event?.detail.target).toBe('C0AUDIT001')
  })
})
