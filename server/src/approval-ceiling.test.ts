import { auditQuery, type Task } from '@seti/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { capOf, defaultsBeyond } from './agent-cap.js'
import { createApp } from './app.js'
import {
  ceilingFrom,
  ceilingNote,
  claudeRules,
  regimeOf,
  type ApprovalRegime,
  type RegimeFacts,
} from './approval-ceiling.js'
import { permissionModeOf } from './bypass-mode.js'
import { setBypass } from './bypass.js'
import { tasks } from './db.js'
import { setPlannerModel } from './planner.js'
import { SETI_TOOLS } from './seti-tools/catalog.js'
import { callSetiTool } from './seti-tools/server.js'
import { approvalCeilings } from './store/approval-ceilings.js'
import { auditEvents } from './store/audit.js'
import { codexSettings } from './store/codex-settings.js'
import { setTaskSetiControl } from './tasks.js'
import { EA_AUTH, USER_AUTH } from './test-auth.js'
import { waitIdle } from './wait-idle.js'

const sdk = await vi.hoisted(async () => {
  const fakes = await import('./fake-sdk.js')
  const fake = new fakes.FakeSdk(async function* () {
    await Promise.resolve()
    yield fakes.fakeMessage('system', {
      subtype: 'init',
      session_id: 'ceiling',
      model: 'haiku',
      permissionMode: 'default',
    })
    yield fakes.fakeResult()
  })
  return { fake, query: fake.query }
})

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  query: sdk.query,
}))

const STRICTNESS: readonly ApprovalRegime[] = ['user', 'rules', 'classifier', 'bypass']
const rank = (regime: ApprovalRegime) => STRICTNESS.indexOf(regime)

/** The callers an agent can be: each runtime, Claude with Bypass, Claude held to Codex's regime. */
const CALLERS: Record<string, Omit<RegimeFacts, 'rulesDecide'>> = {
  claude: { runtime: 'claude', bypass: false, ceiling: null },
  'claude in Bypass': { runtime: 'claude', bypass: true, ceiling: null },
  'claude held to codex': { runtime: 'claude', bypass: false, ceiling: 'codex' },
  codex: { runtime: 'codex', bypass: false, ceiling: null },
}

/** What each pairing gives the child, by Rules decide off and on. */
const EXPECTED: Record<string, Record<'claude' | 'codex', [ApprovalRegime, ApprovalRegime]>> = {
  claude: { claude: ['classifier', 'classifier'], codex: ['user', 'rules'] },
  'claude in Bypass': { claude: ['classifier', 'classifier'], codex: ['user', 'rules'] },
  'claude held to codex': { claude: ['user', 'rules'], codex: ['user', 'rules'] },
  codex: { claude: ['user', 'rules'], codex: ['user', 'rules'] },
}

describe('approval regimes', () => {
  for (const [name, caller] of Object.entries(CALLERS)) {
    for (const child of ['claude', 'codex'] as const) {
      it(`a ${child} child of a ${name} caller settles no call more loosely`, () => {
        const got = [false, true].map((rulesDecide) => {
          const facts = { runtime: child, bypass: false, ceiling: ceilingFrom(caller), rulesDecide }
          expect(rank(regimeOf(facts))).toBeLessThanOrEqual(rank(regimeOf({ ...caller, rulesDecide })))
          return regimeOf(facts)
        })
        expect(got).toEqual(EXPECTED[name]?.[child])
      })
    }
  }

  it('lets the user put a held agent in Bypass', () => {
    expect(regimeOf({ runtime: 'claude', bypass: true, ceiling: 'codex', rulesDecide: false })).toBe('bypass')
  })
})

const app = createApp()
let count = 0

async function newTask(runtime: Task['runtime']): Promise<Task> {
  const id = `ceiling-${String(++count)}`
  await tasks.insert({
    id,
    title: `Caller ${String(count)}`,
    repo_id: null,
    cwd: '/tmp',
    worktree: false,
    pr_urls: [],
    seti_control: 'full',
    runtime,
  })
  const task = await tasks.get(id)
  if (task === undefined) {
    throw new Error('task was not stored')
  }
  return task
}

const startTool = SETI_TOOLS.find((tool) => tool.name === 'start_task')

/** Starts a Claude agent as the caller and waits for its first turn. */
async function startFrom(caller: Task): Promise<Task> {
  setPlannerModel(async () => Promise.resolve({ title: 'Child' }))
  if (startTool === undefined) {
    throw new Error('no start_task tool')
  }
  const result = await callSetiTool(startTool, caller.id, { prompt: 'look around' })
  const { id } = JSON.parse(result.content.map((block) => block.text).join('')) as { id: string }
  await waitIdle(id)
  const child = await tasks.get(id)
  if (child === undefined) {
    throw new Error('the child was not stored')
  }
  return child
}

async function startAs(auth: Record<string, string>): Promise<Task> {
  setPlannerModel(async () => Promise.resolve({ title: 'Started' }))
  const response = await app.request('/api/tasks/start', {
    method: 'POST',
    headers: { host: 'localhost', ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'look around' }),
  })
  expect(response.status).toBe(200)
  const { id } = ((await response.json()) as { data: { id: string } }).data
  await waitIdle(id)
  const task = await tasks.get(id)
  if (task === undefined) {
    throw new Error('the agent was not stored')
  }
  return task
}

const setRulesDecide = async (on: boolean) =>
  codexSettings.set({ ...(await codexSettings.get()), evaluator_decides: on })

afterEach(async () => {
  setPlannerModel(async () => Promise.reject(new Error('no model in tests')))
  await setRulesDecide(false)
})

describe('agents a Codex agent starts', () => {
  it('run Claude Code without its classifier and say so in their start', async () => {
    const caller = await newTask('codex')
    const child = await startFrom(caller)
    expect(await approvalCeilings.get(child.id)).toBe('codex')
    expect(child.setup?.withheld).toContain(ceilingNote(caller.title))
    expect(sdk.fake.last?.options.permissionMode).toBe('default')
    const [created] = (await auditEvents.page(auditQuery.parse({ kind: 'task.created', limit: 1 }))).events
    expect((created?.detail as { withheld?: string[] } | undefined)?.withheld).toContain(ceilingNote(caller.title))
  })

  it('get no allow rule while the user answers every Codex call, and the rules once they decide', async () => {
    const child = await startFrom(await newTask('codex'))
    expect((await claudeRules(child)).allow).toEqual([])
    await setRulesDecide(true)
    expect((await claudeRules(child)).allow).toContain('Read')
    expect(await permissionModeOf(child)).toBe('default')
  })

  it('cannot start agents even once the user gives one Full, so no start escapes the ceiling', async () => {
    const child = await startFrom(await newTask('codex'))
    await setTaskSetiControl(child, 'full')
    const refused = startTool === undefined ? null : await callSetiTool(startTool, child.id, { prompt: 'look again' })
    expect(refused?.isError).toBe(true)
    expect(refused?.content.map((block) => block.text).join('')).toContain('Another agent started you')
  })

  it('may still be put in Bypass by the user, and fall back to Codex regime after', async () => {
    const child = await startFrom(await newTask('codex'))
    await setBypass(child, 2)
    expect(await permissionModeOf((await tasks.get(child.id)) ?? child)).toBe('bypassPermissions')
    await setBypass((await tasks.get(child.id)) ?? child, null)
    expect(await permissionModeOf((await tasks.get(child.id)) ?? child)).toBe('default')
  })

  it('cannot import sessions, which would run under the classifier', async () => {
    const caller = await newTask('codex')
    expect(await defaultsBeyond(await capOf(caller))).toContain(
      "Claude Code's classifier, which decides calls a Codex agent asks about",
    )
  })
})

describe('agents nobody held', () => {
  it('a Claude agent starts Claude agents in auto mode', async () => {
    const child = await startFrom(await newTask('claude'))
    expect(await approvalCeilings.get(child.id)).toBeNull()
    expect(sdk.fake.last?.options.permissionMode).toBe('auto')
    expect((await claudeRules(child)).allow).toContain('Read')
  })

  it('the user and the EA start agents with the defaults', async () => {
    for (const auth of [USER_AUTH, EA_AUTH]) {
      const task = await startAs(auth)
      expect(await approvalCeilings.get(task.id)).toBeNull()
      expect(await permissionModeOf(task)).toBe('auto')
    }
  })
})
