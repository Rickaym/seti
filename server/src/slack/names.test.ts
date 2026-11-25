import { slackDestination, slackLookUpNote, slackPlace } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { idsIn, readableSlack } from './names.js'

describe('readableSlack', () => {
  const names = new Map([
    ['C0DEPLOY01', 'deploys'],
    ['U0DANA0001', 'Dana'],
  ])

  it('shows names for markup and known bare ids, and leaves links and unknown ids alone', () => {
    const text =
      '<@U0DANA0001> asked in <#C0DEPLOY01> and C0DEPLOY01 about <#C0OTHER001|other>, ' +
      'see https://acme.slack.com/archives/C0DEPLOY01/p1 and <@U0UNKNOWN1>'
    expect(readableSlack(text, names)).toBe(
      '@Dana asked in #deploys and #deploys about #other, ' +
        'see https://acme.slack.com/archives/C0DEPLOY01/p1 and <@U0UNKNOWN1>',
    )
    expect(idsIn(text)).toEqual(['U0DANA0001', 'C0DEPLOY01', 'C0OTHER001', 'U0UNKNOWN1'])
  })

  it('says plainly when a name is not known', () => {
    expect(slackPlace('C0DEPLOY01', names)).toBe('#deploys')
    expect(slackPlace('U0DANA0001', names)).toBe('Dana')
    expect(slackPlace('C0NOPE0001', names)).toBe('channel C0NOPE0001, name not known')
    expect(slackPlace('D0DIRECT01', names)).toBe('direct message D0DIRECT01, name not known')
    expect(slackPlace('U0NOPE0001', names)).toBe('Slack user U0NOPE0001, name not known')
  })

  it('names the destination of a Slack send call', () => {
    const send = 'mcp__plugin_slack_slack__slack_send_message'
    expect(slackDestination(send, { channel_id: 'C0DEPLOY01', message: 'x' }, names)).toBe('Send to #deploys')
    expect(slackDestination(send, { channel_id: 'U0DANA0001', message: 'x' }, names)).toBe('DM to Dana')
    expect(slackDestination(send, { channel_id: 'C0NOPE0001', thread_ts: '1.2' }, names)).toBe(
      'Send to channel C0NOPE0001, name not known, in a thread',
    )
    const draft = 'mcp__plugin_slack_slack__slack_send_message_draft'
    expect(slackDestination(draft, { channel_id: 'C0DEPLOY01' }, names)).toBe('Draft to #deploys')
    expect(slackDestination('mcp__linear__save_comment', { channel_id: 'C0DEPLOY01' }, names)).toBeNull()
    expect(
      slackDestination('mcp__plugin_slack_slack__slack_read_channel', { channel_id: 'C0DEPLOY01' }, names),
    ).toBeNull()
    const dm = new Map([['D0SAMLEE01', 'Sam Lee']])
    expect(slackDestination(send, { channel_id: 'D0SAMLEE01', message: 'x' }, dm)).toBe('DM to Sam Lee')
    expect(slackDestination(send, { channel_id: 'D0NOPE0001', message: 'x' }, dm)).toBe(
      'Send to direct message D0NOPE0001, name not known',
    )
  })

  it('tells the agent which read states the name it should look up', () => {
    expect(slackLookUpNote('C0NOPE0001')).toContain('slack_read_channel with channel_id C0NOPE0001')
    expect(slackLookUpNote('U0NOPE0001')).toContain('slack_read_user_profile with user_id U0NOPE0001')
    expect(slackLookUpNote('D0NOPE0001')).toContain('slack_list_user_channels')
  })
})
