import { describe, expect, it } from 'vitest'
import { editMarkText } from './edit-mark'

const SLACK = 'mcp__plugin_slack_slack__slack_send_message'

describe('editMarkText', () => {
  it('says a Slack message the user edited was sent, and that the row above is the draft', () => {
    expect(editMarkText({ fields: ['message'], denied: false, tool: SLACK })).toBe(
      "You edited the message before it was sent. Above is the agent's draft.",
    )
  })

  it('says nothing was sent when the user edited a Slack message and then denied it', () => {
    expect(editMarkText({ fields: ['channel_id', 'message'], denied: true, tool: SLACK })).toBe(
      'You edited the channel id and message, then denied it. Nothing was sent.',
    )
  })

  it('words a Slack draft and a scheduled message by what they do', () => {
    const draft = 'mcp__plugin_slack_slack__slack_send_message_draft'
    expect(editMarkText({ fields: ['message'], denied: false, tool: draft })).toBe(
      "You edited the message before it was saved as a draft. Above is the agent's draft.",
    )
    const later = 'mcp__plugin_slack_slack__slack_schedule_message'
    expect(editMarkText({ fields: ['message'], denied: true, tool: later })).toBe(
      'You edited the message, then denied it. Nothing was scheduled.',
    )
  })

  it('names any other call by its server and tool', () => {
    const tool = 'mcp__github__create_issue'
    expect(editMarkText({ fields: ['title', 'body', 'labels'], denied: false, tool })).toBe(
      "You edited the title, body and labels before github.create_issue ran. Above is the agent's draft.",
    )
    expect(editMarkText({ fields: ['title'], denied: true, tool })).toBe(
      'You edited the title, then denied github.create_issue. Nothing ran.',
    )
  })

  it('says the call when a mark stored before the tool name has none', () => {
    expect(editMarkText({ fields: ['text'], denied: false })).toBe(
      "You edited the text before the call ran. Above is the agent's draft.",
    )
  })
})
