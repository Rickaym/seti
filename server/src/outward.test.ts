import { describe, expect, it } from 'vitest'
import { isOutward } from './outward.js'

describe('isOutward', () => {
  it.each([
    ['mcp__plugin_slack_slack__slack_send_message', {}, true],
    ['mcp__plugin_slack_slack__slack_read_channel', {}, false],
    ['mcp__clickup__clickup_get_task', {}, false],
    ['mcp__clickup__clickup_update_task', {}, true],
    ['mcp__sentry__listIssues', {}, false],
    ['mcp__sentry__createIssues', {}, true],
    ['mcp__claude_ai_Google_Drive__read_file_content', {}, false],
    ['mcp__posthog__insight-create-from-query', {}, true],
    ['mcp__posthog__feature-flag-get-all', {}, false],
    ['mcp__unknown__frobnicate', {}, true],
    ['Bash', { command: 'git push -u origin feat/x' }, true],
    ['Bash', { command: 'gh pr create --fill' }, true],
    ['Bash', { command: 'gh pr view 12 --json state' }, false],
    ['Bash', { command: 'kubectl -n acme-app get pods' }, false],
    ['Bash', { command: 'kubectl apply -f x.yaml' }, true],
    ['Bash', { command: 'ls -la' }, false],
    ['Edit', { file_path: 'src/app.ts' }, false],
  ])('%s %j -> %s', (name, input, expected) => {
    expect(isOutward(name, input)).toBe(expected)
  })
})
