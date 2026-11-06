import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it } from 'vitest'
import { createPrWatcher, createsPr } from './pr-link.js'

const URL = 'https://github.com/Octocat/seti/pull/7'
const URL_TEXT = `Creating pull request\n${URL}\n`

const created = (url: string, parent: string | null = null) => ({ url, parent })

const toolUse = (id: string, command: string, parent: string | null = null) =>
  ({
    type: 'assistant',
    parent_tool_use_id: parent,
    message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] },
  }) as unknown as SDKMessage

const toolResult = (id: string, content: string, isError = false, parent: string | null = null) =>
  ({
    type: 'user',
    parent_tool_use_id: parent,
    message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] },
  }) as unknown as SDKMessage

describe('createsPr', () => {
  it.each([
    ['gh pr create --fill', true],
    ['cd api && gh pr create -R a/b --title x', true],
    ['gh api repos/a/b/pulls -f title=x -f head=y -f base=main', true],
    ['gh api --method POST repos/a/b/pulls --input body.json', true],
    ['gh api -X POST /repos/a/b/pulls --input -', true],
    ['gh api repos/a/b/pulls', false],
    ['gh api repos/a/b/pulls -X GET -f state=open', false],
    ['gh api repos/a/b/pulls/7 -f state=closed', false],
    ['gh api repos/a/b/pulls/7/comments -f body=hi', false],
    ['gh pr view 7', false],
  ])('%s -> %s', (command, expected) => {
    expect(createsPr(command)).toBe(expected)
  })
})

describe('createPrWatcher', () => {
  it('returns the URL printed by gh pr create', () => {
    const watch = createPrWatcher()
    expect(watch('t1', toolUse('a', 'gh pr create --fill --base main'))).toEqual([])
    expect(watch('t1', toolResult('a', URL_TEXT))).toEqual([created(URL)])
  })

  it('names the subagent call a PR-creating command ran under', () => {
    const watch = createPrWatcher()
    watch('t1', toolUse('a', 'gh pr create --fill', 'toolu_agent'))
    expect(watch('t1', toolResult('a', URL_TEXT, false, 'toolu_agent'))).toEqual([created(URL, 'toolu_agent')])
  })

  it('ignores PR URLs from commands that do not create PRs', () => {
    const watch = createPrWatcher()
    watch('t1', toolUse('a', 'gh pr view 7 --json url'))
    expect(watch('t1', toolResult('a', URL_TEXT))).toEqual([])
  })

  it('keeps PRs a command created even when a later step in it failed', () => {
    const watch = createPrWatcher()
    const api = 'https://github.com/Octocat/api/pull/3'
    watch('t1', toolUse('a', 'A=$(gh pr create --fill -R x/web) && B=$(gh pr create --fill -R x/api); gh pr edit 3'))
    const output = `Exit code 1\n${URL}\n${api}\nGraphQL: Projects (classic) is being deprecated`
    expect(watch('t1', toolResult('a', output, true))).toEqual([created(URL), created(api)])
  })

  it('links PRs created through gh api', () => {
    const watch = createPrWatcher()
    watch('t1', toolUse('a', 'jq -n "{}" | gh api repos/Octocat/seti/pulls --input - -q .html_url'))
    expect(watch('t1', toolResult('a', `${URL}\n`))).toEqual([created(URL)])
  })

  it('links PRs created through a GitHub MCP server, and nothing other MCP tools print', () => {
    const watch = createPrWatcher()
    const mcp = (id: string, name: string) =>
      ({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id, name, input: { owner: 'Octocat', repo: 'seti' } }] },
      }) as unknown as SDKMessage
    watch('t1', mcp('a', 'mcp__github__create_pull_request'))
    expect(watch('t1', toolResult('a', JSON.stringify({ html_url: URL })))).toEqual([created(URL)])
    watch('t1', mcp('b', 'mcp__github__list_pull_requests'))
    expect(watch('t1', toolResult('b', URL_TEXT))).toEqual([])
  })

  it('keeps tasks apart', () => {
    const watch = createPrWatcher()
    watch('t1', toolUse('a', 'gh pr create --fill'))
    expect(watch('t2', toolResult('a', URL_TEXT))).toEqual([])
    expect(watch('t1', toolResult('a', URL_TEXT))).toEqual([created(URL)])
  })

  it('reports every PR a task creates, across repos and in one message', () => {
    const watch = createPrWatcher()
    const api = 'https://github.com/Octocat/api/pull/3'
    const web = 'https://github.com/Octocat/web/pull/4'
    watch('t1', toolUse('a', 'gh pr create --fill'))
    expect(watch('t1', toolResult('a', URL_TEXT))).toEqual([created(URL)])
    const both = {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'cd ../api && gh pr create --fill' } },
          { type: 'tool_use', id: 'c', name: 'Bash', input: { command: 'cd ../web && gh pr create --fill' } },
        ],
      },
    } as unknown as SDKMessage
    watch('t1', both)
    const results = {
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'b', content: `${api}\n` },
          { type: 'tool_result', tool_use_id: 'c', content: [{ type: 'text', text: web }] },
        ],
      },
    } as unknown as SDKMessage
    expect(watch('t1', results)).toEqual([created(api), created(web)])
    expect(watch('t1', results)).toEqual([])
  })
})
