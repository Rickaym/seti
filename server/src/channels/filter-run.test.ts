import { afterAll, describe, expect, it } from 'vitest'
import type { FilterEventInput } from './filter-protocol.js'
import { createFilterPool, filterHeaders, runFilter } from './filter-run.js'

const workers = createFilterPool(1)

afterAll(async () => {
  await workers.close()
})

const input: FilterEventInput = {
  event: 'issue.update',
  action: 'update',
  title: 'Fix the login page',
  link: 'https://linear.example/issue/1',
  detail: 'It fails on Safari',
  headers: { 'linear-event': 'Issue' },
  payload: { data: { assignee: { email: 'me@example.com' } }, type: 'Issue' },
}

const run = async (script: string) => runFilter(script, input, workers)

describe('webhook filter engine', () => {
  it('keeps, drops and changes deliveries by what the filter returns', async () => {
    expect(await run('export default () => true')).toMatchObject({ outcome: 'kept' })
    expect(await run('export default () => null')).toMatchObject({ outcome: 'dropped' })
    expect(await run('export default () => false')).toMatchObject({ outcome: 'dropped' })
    expect(await run('export default () => ({})')).toMatchObject({ outcome: 'kept' })
    expect(await run("export default (e) => ({ title: e.title + ' (mine)', link: null })")).toMatchObject({
      outcome: 'changed',
      change: { title: 'Fix the login page (mine)', link: '' },
    })
  })

  it('reads the event, its payload and its headers, and may be async and log', async () => {
    const script = `export default async function filter(event, { log }) {
      await Promise.resolve()
      log('seen', event.action, event.headers['linear-event'])
      return event.payload.data.assignee.email === 'me@example.com' ? { event: 'issue.mine' } : null
    }`
    expect(await run(script)).toEqual({
      outcome: 'changed',
      change: { event: 'issue.mine' },
      logs: ['seen update Issue'],
    })
  })

  it('fails a filter that throws, returns nothing usable or sets a bad field', async () => {
    const cases: [string, string][] = [
      ["export default () => { throw new Error('nope') }", 'Error: nope (line 1)'],
      ['export default () => {}', 'The filter returned nothing; return null or false'],
      ['export default () => 3', 'The filter returned number'],
      ["export default () => 'drop'", 'The filter returned string'],
      ['export default () => [1]', 'The filter returned array'],
      ["export default () => ({ titel: 'x' })", 'The filter returned an unknown field titel'],
      ['export default () => ({ title: 5 })', 'The filter returned title as number, not a string'],
      ["export default () => ({ link: 'javascript:alert(1)' })", 'not an http or https URL'],
      ['export const filter = () => true', 'Export the filter function'],
    ]
    for (const [script, error] of cases) {
      const verdict = await run(script)
      expect(verdict.outcome, script).toBe('failed')
      expect(verdict.outcome === 'failed' ? verdict.error : '', script).toContain(error)
    }
  })

  it('clips long text to the field limits', async () => {
    const verdict = await run("export default () => ({ title: 'x'.repeat(500) })")
    expect(verdict.outcome === 'changed' ? verdict.change.title?.length : 0).toBe(200)
  })

  it('stops a filter that runs too long or uses too much memory, and the next one still runs', async () => {
    const spin = await run('export default () => { for (;;) {} }')
    expect(spin.outcome === 'failed' ? spin.error : '').toMatch(/^The script (ran over|computed for over)/)
    const hog = await run(`export default () => {
      const kept = []
      for (;;) kept.push('x'.repeat(100000) + kept.length)
    }`)
    expect(hog).toMatchObject({ outcome: 'failed', error: 'The script ran out of memory (32 MB)' })
    expect(await run('export default () => true')).toMatchObject({ outcome: 'kept' })
  })

  it('has no network, files, processes or Node to reach', async () => {
    const tries = [
      "export default async () => { await fetch('https://example.com'); return true }",
      "import fs from 'fs'\nexport default () => fs.readFileSync('/etc/passwd', 'utf8') !== ''",
      "export default () => require('child_process') !== null",
      'export default () => process.env.HOME !== undefined',
      "export default async () => { await import('node:fs'); return true }",
    ]
    for (const script of tries) {
      expect((await run(script)).outcome, script).toBe('failed')
    }
  })

  it('fails a delivery that waits too long for a busy worker instead of holding the sender', async () => {
    const spin = 'export default () => { for (;;) {} }'
    const verdicts = await Promise.all([run(spin), run(spin), run(spin), run('export default () => true')])
    expect(verdicts.at(-1)).toEqual({ outcome: 'failed', error: 'Every filter worker stayed busy for 2 s', logs: [] })
  })
})

describe('filter headers', () => {
  it('shows only allowlisted headers and never a signature or token', () => {
    const headers = new Headers({
      'X-GitHub-Event': 'check_run',
      'X-Hub-Signature-256': 'sha256=abc',
      Authorization: 'Bearer secret-value',
      'Linear-Signature': 'abc',
      'X-Seti-Signature': 'sha256=abc',
      Cookie: 'a=b',
      'User-Agent': 'GitHub-Hookshot/1',
      'X-Custom': 'kept out',
    })
    expect(filterHeaders(headers)).toEqual({ 'user-agent': 'GitHub-Hookshot/1', 'x-github-event': 'check_run' })
  })
})
