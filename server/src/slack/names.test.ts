import { slackDestination, slackPlace } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { idsIn, namesIn, readableSlack } from './names.js'

describe('namesIn', () => {
  it('reads names beside ids in Slack markup and in the Slack MCP server answers', () => {
    const answer = JSON.stringify({
      results:
        '## Messages\nChannel: #deploys (ID: C0DEPLOY01)\nFrom: Dana Reyes <dana@example.com> (ID: U0DANA0001)\n' +
        'Text: <@U0SAM00001|Sam Lee> see <#C0OPS00001|ops>\n---\n### Result 1 of 1\nName: #release-train\n' +
        'Creator: x\nPermalink: [link](https://acme.slack.com/archives/C0TRAIN001)\n---\nName: Kim Ito\nUser ID: U0KIM00001',
    }).replaceAll('/', '\\/')
    expect(namesIn(answer).map(({ id, kind, name }) => `${kind} ${id} ${name}`)).toEqual([
      'channel C0OPS00001 ops',
      'channel C0DEPLOY01 deploys',
      'channel C0TRAIN001 release-train',
      'user U0SAM00001 Sam Lee',
      'user U0DANA0001 Dana Reyes',
      'user U0KIM00001 Kim Ito',
    ])
    expect(namesIn('Channel: #general (C0GENERAL1)\n\nbody')).toEqual([
      { id: 'C0GENERAL1', kind: 'channel', name: 'general' },
    ])
  })

  it('learns nothing from text without names, and the last sighting of an id wins', () => {
    expect(namesIn('Posted to C0DEPLOY01 at 1700000000.000100')).toEqual([])
    expect(namesIn('<#C0DEPLOY01|old> then <#C0DEPLOY01|new>')).toEqual([
      { id: 'C0DEPLOY01', kind: 'channel', name: 'new' },
    ])
  })
})

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
  })
})
