import { describe, expect, it } from 'vitest'
import { INPUT_TEXT_BUDGET, outwardRecord, preview, toolDisplayName, TRUNCATED } from './outward-detail.js'

describe('toolDisplayName', () => {
  it.each([
    ['mcp__plugin_slack_slack__slack_send_message', 'Slack send_message'],
    ['mcp__clickup__clickup_create_task', 'Clickup create_task'],
    ['mcp__claude_ai_Gmail__send_email', 'Gmail send_email'],
    ['mcp__seti__post_team_chat', 'Seti post_team_chat'],
    ['mcp__acme-app__create_call', 'Acme-app create_call'],
    ['Bash', 'Bash'],
    ['WebFetch', 'WebFetch'],
  ])('%s reads as %s', (name, shown) => {
    expect(toolDisplayName(name)).toBe(shown)
  })
})

describe('preview', () => {
  it('keeps short text on one line', () => {
    expect(preview('  hello\n  there ')).toBe('hello there')
  })

  it('cuts long text to 80 characters', () => {
    const out = preview('word '.repeat(40))
    expect(out).toHaveLength(80)
    expect(out.endsWith('...')).toBe(true)
  })
})

describe('outwardRecord', () => {
  it('keeps the text of a direct group chat message out, with its recipient and length', () => {
    const sent = outwardRecord('mcp__seti__post_team_chat', { to: '@tony', text: 'the secret plan' })
    expect(sent.summary).toBe('Seti post_team_chat \u2192 @tony: a direct message of 15 characters')
    expect(sent.detail).toEqual({ target: '@tony', length: 15 })
    expect(JSON.stringify(sent)).not.toContain('secret plan')
    expect(outwardRecord('mcp__seti__post_team_chat', { text: 'public news' }).detail).toMatchObject({
      text: 'public news',
    })
  })

  it('names the Slack channel, thread and message', () => {
    const sent = outwardRecord('mcp__plugin_slack_slack__slack_send_message', {
      channel_id: 'C0123ABC',
      thread_ts: '1712.5',
      text: 'Deploy finished\nAll green',
      unfurl_links: false,
    })
    expect(sent.summary).toBe('Slack send_message \u2192 C0123ABC thread 1712.5: "Deploy finished All green"')
    expect(sent.detail).toEqual({
      target: 'C0123ABC thread 1712.5',
      text: 'Deploy finished\nAll green',
      input: '{"unfurl_links":false}',
    })
  })

  it('joins a list of recipients and prefers the body over the subject', () => {
    const sent = outwardRecord('mcp__gmail__send_email', { to: ['a@x.test', 'b@x.test'], subject: 'Hi', body: 'Text' })
    expect(sent.summary).toBe('Gmail send_email \u2192 a@x.test, b@x.test: "Text"')
    expect(sent.detail).toMatchObject({ target: 'a@x.test, b@x.test', text: 'Text', input: '{"subject":"Hi"}' })
  })

  it('falls back to the tool name and the first string field', () => {
    const sent = outwardRecord('mcp__linear__create_issue', { team: 7, title: 'Broken login', labels: ['bug'] })
    expect(sent.summary).toBe('Linear create_issue: "Broken login"')
    expect(sent.detail).toEqual({ input: '{"team":7,"title":"Broken login","labels":["bug"]}' })
  })

  it('shows only the tool name when the input has no text', () => {
    expect(outwardRecord('mcp__x__trigger_build', { id: 4 }).summary).toBe('X trigger_build')
    expect(outwardRecord('mcp__x__trigger_build', {}).detail).toEqual({})
  })

  it('keeps Bash as the command', () => {
    const sent = outwardRecord('Bash', { command: 'git push origin main', description: 'Push' })
    expect(sent.summary).toBe('Bash: git push origin main')
    expect(sent.detail).toEqual({ text: 'git push origin main', input: '{"description":"Push"}' })
  })

  it('redacts secret fields and secret-looking text before anything is kept', () => {
    const sent = outwardRecord('mcp__hook__post_webhook', {
      channel: '#ops',
      message: 'token ghp_abcdefghijklmnop1234',
      api_key: 'plain-value',
      nested: { password: 'hunter2', url: 'https://me:pw123456@example.com' },
    })
    const all = JSON.stringify(sent)
    expect(all).not.toMatch(/ghp_|plain-value|hunter2|pw123456/)
    expect(sent.detail.text).toBe('token [redacted]')
    expect(JSON.parse(String(sent.detail.input))).toEqual({
      api_key: '[redacted]',
      nested: { password: '[redacted]', url: 'https://[redacted]@example.com' },
    })
  })

  it('shares one text budget across fields, text first, and marks the cut', () => {
    const long = 'a'.repeat(INPUT_TEXT_BUDGET + 500)
    const sent = outwardRecord('mcp__slack__send_message', { text: long, note: 'kept?' })
    expect(sent.detail.text).toBe(`${'a'.repeat(INPUT_TEXT_BUDGET)}${TRUNCATED}`)
    expect(sent.detail.input).toBe(`{"note":"${TRUNCATED}"}`)
    expect(sent.detail.truncated).toBe(true)
    expect(sent.summary.length).toBeLessThan(120)
  })

  it('bounds long lists and deep nesting', () => {
    const sent = outwardRecord('mcp__x__bulk_update', { ids: Array.from({ length: 50 }, (_, i) => i) })
    expect((JSON.parse(String(sent.detail.input)) as { ids: number[] }).ids).toHaveLength(20)
    expect(sent.detail.truncated).toBe(true)
    const deep = outwardRecord('mcp__x__set_config', { a: { b: { c: { d: { e: 1 } } } } })
    expect(deep.detail.input).toBe('{"a":{"b":{"c":{"d":"[truncated]"}}}}')
  })
})
