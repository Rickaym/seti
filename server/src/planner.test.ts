import { plannerOutput, type PlannerOutput } from '@seti/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { asksForAws, asksForHost, checkPlan, fallbackTitle, type PlannerCatalog } from './planner-rules.js'
import { extractJson, planAgent, plannerRequest, planTitle, setPlannerModel, type PlannerModel } from './planner.js'

const CATALOG: PlannerCatalog = {
  repos: [
    { id: 'r-api', slug: 'acme/api', description: 'The public API' },
    { id: 'r-web', slug: 'acme/web', description: '', path: '/code/web' },
  ],
  packs: [
    { id: 'p-guide', name: 'Seti guide', description: 'How Seti runs agents', linked_by_default: true, builtin: true },
    { id: 'p-style', name: 'Style', description: 'House style', linked_by_default: true, builtin: false },
    { id: 'p-infra', name: 'Infra', description: 'Hosts and deploys', linked_by_default: false, builtin: false },
  ],
  mcp: [
    { name: 'clickup', default_enabled: false },
    { name: 'slack', default_enabled: true },
    { name: 'web-staging', default_enabled: false, local_to: ['/code/web'] },
  ],
  ssh_hosts: [
    { alias: 'k8s', default_enabled: false },
    { alias: 'voip', default_enabled: false },
    { alias: 'bastion', default_enabled: true },
  ],
  aws: { available: true, default_enabled: false },
}

const answer = (fields: Partial<PlannerOutput>): PlannerOutput => plannerOutput.parse(fields)

const plan = (message: string, fields: Partial<PlannerOutput>, pins = {}) =>
  checkPlan({ raw: answer(fields), message, reason: null, ms: 5 }, CATALOG, pins)

const stub =
  (reply: unknown): PlannerModel =>
  async () =>
    Promise.resolve(reply)

describe('titles', () => {
  it('falls back to the opening words of the first line, capitalised and clipped at a word', () => {
    expect(fallbackTitle('fix the login bug\nand more')).toBe('Fix the login bug')
    expect(fallbackTitle('/review "the PR"')).toBe('Review "the PR')
    expect(fallbackTitle('   ')).toBe('New agent')
    const long = fallbackTitle('please go through every single file in the repository and rename the widgets')
    expect(long.length).toBeLessThanOrEqual(60)
    expect(long.endsWith(' ')).toBe(false)
    expect('please go through every single file in the repository and rename'.startsWith(long.toLowerCase())).toBe(true)
  })

  it('cleans the model title of quotes and length, and uses the message when it is empty', () => {
    expect(plan('fix it', { title: '"Fix the login bug."' }).title).toBe('Fix the login bug')
    expect(plan('fix the parser', { title: '' }).title).toBe('Fix the parser')
    expect(plan('x', { title: 'a'.repeat(80) }).title).toHaveLength(60)
  })

  it('keeps a pinned title as given', () => {
    expect(plan('fix it', { title: 'Model title' }, { title: 'My title' }).title).toBe('My title')
  })
})

describe('the prompt', () => {
  it('lists every choice with its default and wraps the message', () => {
    const request = plannerRequest('Deploy to k8s', CATALOG)
    expect(request.system).toContain('Unclear permissions are NOT given')
    expect(request.system).toContain('"ssh_hosts": string[]')
    expect(request.prompt).toContain('- acme/api: The public API')
    expect(request.prompt).toContain('- acme/web\n')
    expect(request.prompt).toContain('- Seti guide: How Seti runs agents [linked by default]')
    expect(request.prompt).toContain('- clickup [off by default]')
    expect(request.prompt).toContain('SSH hosts:\n- k8s [off by default]\n- voip [off by default]')
    expect(request.prompt).toContain('AWS: a role, off by default')
    expect(request.prompt.endsWith('<message>\nDeploy to k8s\n</message>')).toBe(true)
  })

  it('asks for a title alone without the lists', () => {
    const request = plannerRequest('Fix it', CATALOG, true)
    expect(request.prompt).not.toContain('acme/api')
    expect(request.prompt).toContain('Only the title matters here')
  })

  it('reads the JSON object out of a fenced or chatty answer', () => {
    expect(extractJson('Sure:\n```json\n{"title": "x"}\n```')).toEqual({ title: 'x' })
    expect(() => extractJson('no json here')).toThrow('without JSON')
  })
})

describe('the rules', () => {
  it('takes only repos that exist, by slug or name, and worktrees them by default', () => {
    const result = plan('work on api and web', { repos: ['acme/api', 'web', 'acme/ghost', 'ACME/API'] })
    expect(result.repo_ids).toEqual(['r-api', 'r-web'])
    expect(result.worktree).toBe(true)
    expect(result.setup.repos).toEqual(['acme/api', 'acme/web'])
    expect(result.setup.withheld).toEqual(['unknown repo acme/ghost'])
  })

  it('gives no repo a fresh folder and no worktree', () => {
    const result = plan('write a poem', { repos: [], worktree: true })
    expect(result.repo_ids).toEqual([])
    expect(result.worktree).toBe(false)
  })

  it('keeps pinned repos and their worktree choice over the answer', () => {
    const pinned = plan('x', { repos: ['acme/web'], worktree: true }, { repo_ids: ['r-api'], worktree: false })
    expect(pinned.repo_ids).toEqual(['r-api'])
    expect(pinned.worktree).toBe(false)
    expect(plan('x', { repos: ['acme/web'] }, { cwd: '/tmp' }).repo_ids).toEqual([])
  })

  it('links default packs, adds known ones and never drops the built-in guide', () => {
    const result = plan('x', {
      link_packs: ['infra', 'Nope', 'Style'],
      unlink_packs: ['Seti guide', 'Style', 'Infra'],
    })
    expect(result.context_pack_ids).toEqual(['p-guide', 'p-infra'])
    expect(result.setup.packs_linked).toEqual(['Infra'])
    expect(result.setup.packs_unlinked).toEqual(['Style'])
  })

  it('flips MCP servers only against their defaults and only when they exist', () => {
    const result = plan('x', { enable_mcp: ['clickup', 'slack', 'ghost'], disable_mcp: ['slack', 'clickup'] })
    expect(result.mcp_enabled).toEqual(['clickup'])
    expect(result.mcp_disabled).toEqual(['slack'])
  })

  it('turns on a local server of another directory only when the message names it', () => {
    const vague = plan('check the staging data', { enable_mcp: ['web-staging', 'clickup'] })
    expect(vague.mcp_enabled).toEqual(['clickup'])
    expect(vague.setup.withheld).toEqual(['MCP web-staging: not asked for explicitly'])
    const named = plan('look it up with web-staging', { enable_mcp: ['web-staging'] })
    expect(named.mcp_enabled).toEqual(['web-staging'])
    expect(named.setup.withheld).toEqual([])
    const inRepo = plan('check the staging data', { repos: ['acme/web'], enable_mcp: ['web-staging'] })
    expect(inRepo.mcp_enabled).toEqual([])
    expect(inRepo.setup.withheld).toEqual([])
  })

  it('never grants SSH hosts or AWS the message does not explicitly ask for', () => {
    const vague = plan('look into why the deploy is slow on the server', { ssh_hosts: ['k8s'], aws: true })
    expect(vague.access).toEqual([])
    expect(vague.setup.access).toEqual([])
    expect(vague.setup.withheld).toEqual(['SSH k8s: not asked for explicitly', 'AWS: not asked for explicitly'])
  })

  it('grants the SSH hosts and AWS the message names, when the model agrees', () => {
    const explicit = plan('ssh to voip and read the CloudWatch logs in AWS', { ssh_hosts: ['voip'], aws: true })
    expect(explicit.access).toEqual([
      { kind: 'ssh', id: 'voip', enabled: true },
      { kind: 'aws', id: 'aws', enabled: true },
    ])
    expect(explicit.setup.access).toEqual(['SSH voip', 'AWS'])
    expect(plan('ssh to voip and check aws', {}).access).toEqual([])
    expect(plan('ssh to k8s', { ssh_hosts: ['voip'] }).setup.withheld).toEqual(['SSH voip: not asked for explicitly'])
  })

  it('needs no grant for access that is on by default', () => {
    const onByDefault = plan('ssh to bastion', { ssh_hosts: ['bastion'] })
    expect(onByDefault.access).toEqual([])
    expect(onByDefault.setup.withheld).toEqual([])
  })

  it('grants nothing that is not configured, and nothing to the EA', () => {
    const bare = checkPlan(
      { raw: answer({ ssh_hosts: ['k8s'], aws: true }), message: 'ssh to k8s and check aws', reason: null, ms: 5 },
      { ...CATALOG, ssh_hosts: [], aws: { available: false, default_enabled: false } },
    )
    expect(bare.setup.withheld).toEqual(['SSH k8s: not configured', 'AWS: not configured'])
    const ea = plan('ssh to k8s and check aws', { ssh_hosts: ['k8s'], aws: true }, { fromEa: true })
    expect(ea.access).toEqual([])
    expect(ea.setup.withheld).toEqual(['SSH k8s: the EA cannot grant it', 'AWS: the EA cannot grant it'])
  })

  it('reads explicit asks by word, not inside other words', () => {
    expect(asksForHost('log in to k8s and restart it', 'k8s')).toBe(true)
    expect(asksForHost('k8s-tools is a package name', 'k8s')).toBe(false)
    expect(asksForAws('list the S3 buckets')).toBe(true)
    expect(asksForAws('draw a saws diagram')).toBe(false)
  })
})

describe('planning with the model', () => {
  afterEach(() => {
    setPlannerModel(async () => Promise.reject(new Error('no model in tests')))
  })

  it('uses the answer after the rules', async () => {
    setPlannerModel(stub({ title: 'Fix login', repos: [], aws: true }))
    const result = await planAgent('fix the login page')
    expect(result.title).toBe('Fix login')
    expect(result.access).toEqual([])
    expect(result.setup.planner).toBe('model')
    expect(result.setup.fallback_reason).toBeNull()
  })

  it('falls back to defaults when the model fails, times out or answers in the wrong shape', async () => {
    setPlannerModel(async () => Promise.reject(new Error('not logged in')))
    const failed = await planAgent('fix the login page')
    expect(failed.title).toBe('Fix the login page')
    expect(failed.repo_ids).toEqual([])
    expect(failed.setup).toMatchObject({ planner: 'fallback', fallback_reason: 'not logged in', access: [] })

    let aborted = false
    setPlannerModel(async (_request, signal) => {
      signal.addEventListener('abort', () => {
        aborted = true
      })
      return new Promise(() => undefined)
    })
    const slow = await planAgent('rename the widgets', {}, 30)
    expect(slow.setup.fallback_reason).toBe('Timed out after 30 ms waiting for the planner')
    expect(slow.title).toBe('Rename the widgets')
    expect(aborted).toBe(true)

    setPlannerModel(stub({ title: 42 }))
    expect((await planAgent('fix it')).setup.fallback_reason).toBe('The planner answered in the wrong shape')
  })

  it('titles alone from the same call, or from the message when it fails', async () => {
    setPlannerModel(stub({ title: 'Summarise the incident', repos: ['acme/api'] }))
    expect(await planTitle('what happened last night?')).toBe('Summarise the incident')
    setPlannerModel(async () => Promise.reject(new Error('down')))
    expect(await planTitle('what happened last night?')).toBe('What happened last night?')
  })
})
