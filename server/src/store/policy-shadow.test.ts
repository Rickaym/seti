import type { PolicyShadowSummary } from '@seti/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../app.js'
import { tasks } from '../db.js'
import type { ShadowRecord } from '../policy/shadow.js'
import { SETI_TOOLS } from '../seti-tools/catalog.js'
import { callSetiTool } from '../seti-tools/server.js'
import { EA_AUTH, USER_AUTH } from '../test-auth.js'
import { policyShadow } from './policy-shadow.js'

const record = (part: Partial<ShadowRecord>): ShadowRecord => ({
  kind: 'shell',
  tool: 'Bash',
  mode: 'auto',
  sandboxed: true,
  slow: false,
  verdict: 'allow',
  step: 'allow-rule',
  rule: 'rule:1',
  runtime: 'allow',
  result: 'agree',
  ...part,
})

const app = createApp()

async function read(query: string, auth: object): Promise<Response> {
  return app.request(`/api/permissions/shadow${query}`, { headers: { host: 'localhost', ...auth } })
}

const summaryOf = async (res: Response) => ((await res.json()) as { data: PolicyShadowSummary }).data

afterEach(() => {
  vi.useRealTimers()
})

describe('the permission shadow summary', () => {
  it("leaves out the evaluator's verdicts beside a Codex agent's answers", async () => {
    await policyShadow.count({ ...record({}), mode: 'codex', runtime: 'user-allow' }, '2990-03-01')
    const summary = await policyShadow.summary('2990-03-01')
    expect(summary.results).toEqual({})
    expect(summary.differences).toEqual([])
  })

  it('counts results, slow decisions and the most frequent differences since the day', async () => {
    await policyShadow.count(record({}), '2990-01-01')
    await policyShadow.count(record({}), '2990-01-02')
    await policyShadow.count(record({ slow: true }), '2990-01-02')
    const looser = record({ verdict: 'allow', runtime: 'ask', result: 'looser', rule: 'rule:7' })
    await policyShadow.count(looser, '2990-01-03')
    await policyShadow.count(looser, '2990-01-04')
    const tighter = record({ verdict: 'ask', step: 'mode', rule: '', runtime: 'allow', result: 'tighter' })
    await policyShadow.count(tighter, '2990-01-04')
    await policyShadow.failed('2990-01-04')

    const summary = await policyShadow.summary('2990-01-02')
    expect(summary).toEqual({
      since: '2990-01-02',
      results: { agree: 2, looser: 2, tighter: 1, failed: 1 },
      slow: 1,
      differences: [
        {
          result: 'looser',
          kind: 'shell',
          tool: 'Bash',
          mode: 'auto',
          verdict: 'allow',
          step: 'allow-rule',
          rule: 'rule:7',
          runtime: 'ask',
          calls: 2,
        },
        {
          result: 'tighter',
          kind: 'shell',
          tool: 'Bash',
          mode: 'auto',
          verdict: 'ask',
          step: 'mode',
          rule: '',
          runtime: 'allow',
          calls: 1,
        },
      ],
    })
  })

  it('is read through the API by the user and the EA, for 1 to 30 days', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2991-03-10T12:00:00Z'))
    await policyShadow.count(record({ result: 'deferred', verdict: 'defer' }), '2991-03-09')

    const week = await read('', EA_AUTH)
    expect(week.status).toBe(200)
    expect(await summaryOf(week)).toEqual({
      since: '2991-03-04',
      results: { deferred: 1 },
      slow: 0,
      differences: [],
    })
    expect(await summaryOf(await read('?days=1', USER_AUTH))).toEqual({
      since: '2991-03-10',
      results: {},
      slow: 0,
      differences: [],
    })
    expect((await read('?days=31', USER_AUTH)).status).toBe(400)
  })

  it("is in an agent's seti_overview, as the EA's", async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2992-05-20T12:00:00Z'))
    await policyShadow.count(record({ result: 'tighter', verdict: 'ask', runtime: 'allow' }), '2992-05-19')
    const id = 'shadow-overview'
    await tasks.insert({
      id,
      title: id,
      repo_id: null,
      cwd: '/tmp',
      worktree: false,
      pr_urls: [],
      seti_control: 'full',
    })
    const tool = SETI_TOOLS.find((entry) => entry.name === 'seti_overview') ?? expect.fail('No seti_overview')
    const result = await callSetiTool(tool, id, { permissions: true })
    const text = result.content.map((block) => block.text).join('')
    expect(JSON.parse(text)).toMatchObject({ since: '2992-05-14', results: { tighter: 1 }, slow: 0 })
  })
})
