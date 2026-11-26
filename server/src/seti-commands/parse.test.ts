import {
  completeSetiLine,
  parseSetiLine,
  SETI_LINE_MAX,
  type AccessItem,
  type CommandAuthor,
  type CommandWorld,
} from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { agentCapabilities } from '../runtimes/capabilities.js'

const item = (kind: AccessItem['kind'], id: string, fields: Partial<AccessItem> = {}): AccessItem => ({
  kind,
  id,
  name: id,
  detail: null,
  default_enabled: false,
  credential: null,
  override: null,
  enabled: false,
  jump_for: [],
  missing_key: [],
  session: null,
  unusable: null,
  ...fields,
})

const ITEMS = [
  item('mcp', 'playwright'),
  item('mcp', 'github', { override: true, enabled: true }),
  item('mcp', 'sse-only', { unusable: 'A transport this runtime lacks' }),
  item('ssh', 'prod', { credential: true, enabled: true }),
  item('ssh', 'staging', { override: false, credential: true }),
  item('aws', 'aws', { name: 'AWS' }),
  item('plugin', 'lint-kit'),
  item('pack', '5f0e4b1c', { name: 'Style guide' }),
]

function world(author: CommandAuthor = 'user', runtime: 'claude' | 'codex' = 'claude'): CommandWorld {
  return {
    author,
    task: {
      title: 'Fixer',
      sandbox: true,
      home_access: true,
      profile_id: 'default',
      seti_control: 'self',
      bypass_until: null,
      pinned: false,
      notifications_muted: false,
      input_mode: 'wake',
      color: null,
      workspace_id: 'w1',
    },
    caps: agentCapabilities(runtime),
    sandboxOn: true,
    access: {
      task_id: 't1',
      sandboxed: true,
      items: ITEMS,
      profile: { id: 'default', name: 'Default' },
      seti_control: 'self',
      hosts: ['api.example.com:443'],
      aws: { state: 'off', role: 'arn:aws:iam::1:role/r', region: 'eu-central-1' },
      github: { state: 'none' },
    },
    credentials: [
      { id: 'default', name: 'Default' },
      { id: 'p2', name: 'Deploy' },
    ],
    workspaces: [
      { id: 'w1', name: 'Main' },
      { id: 'w2', name: 'Side' },
    ],
    memory: {
      override: null,
      effective: { high_mb: 8192, max_mb: 8192, swap_max_mb: 1024 },
    },
    cpu: { cap: { override: null, effective: { quota_percent: 300 } }, max_percent: 800 },
  }
}

const parsed = (line: string, w = world()) => {
  const result = parseSetiLine(line, w)
  if (!result.ok) {
    throw new Error(`${line}: ${result.reason}`)
  }
  return result.command
}
const refusal = (line: string, w = world()) => {
  const result = parseSetiLine(line, w)
  return result.ok ? null : result.reason
}

describe('Seti command lines', () => {
  it.each([
    ['/seti:access mcp playwright on', ['access', 'mcp', 'playwright', 'on'], false],
    ['/seti:mcp playwright on', ['mcp', 'playwright', 'on'], false],
    ['/seti:access mcp github reset', ['access', 'mcp', 'github', 'reset'], false],
    ['/seti:access ssh staging on', ['access', 'ssh', 'staging', 'on'], true],
    ['/seti:access ssh staging reset', ['access', 'ssh', 'staging', 'reset'], true],
    ['/seti:access ssh prod off', ['access', 'ssh', 'prod', 'off'], false],
    ['/seti:access aws on', ['access', 'aws', 'on'], true],
    ['/seti:access plugin lint-kit on', ['access', 'plugin', 'lint-kit', 'on'], false],
    ['/seti:access pack 5f0e4b1c on', ['access', 'pack', '5f0e4b1c', 'on'], false],
    ['/seti:access host docs.example.org add', ['access', 'host', 'docs.example.org', 'add'], true],
    ['/seti:access host api.example.com:443 remove', ['access', 'host', 'api.example.com:443', 'remove'], false],
    ['/seti:access home off', ['access', 'home', 'off'], true],
    ['/seti:access credential Deploy', ['access', 'credential', 'p2'], true],
    ['/seti:access reset', ['access', 'reset'], true],
    ['/seti:access save', ['access', 'save'], false],
    ['/seti:sandbox off', ['sandbox', 'off'], true],
    ['/seti:bypass 8', ['bypass', '8'], true],
    ['/seti:control full', ['control', 'full'], true],
    ['/seti:control off', ['control', 'off'], false],
    ['/seti:updates queue', ['updates', 'queue'], false],
    ['/seti:color teal', ['color', 'teal'], false],
    ['/seti:notify off', ['notify', 'off'], false],
    ['/seti:pin on', ['pin', 'on'], false],
    ['/seti:chat off', ['chat', 'off'], false],
    ['/seti:nightly off', ['nightly', 'off'], false],
    ['/seti:workspace Side', ['workspace', 'w2'], false],
    ['/seti:rename Fix the   flaky test', ['rename', 'Fix the flaky test'], false],
    ['/seti:memory 12g', ['memory', '12288'], false],
    ['/seti:memory 10g', ['memory', '10240'], false],
    ['/seti:cpu 2', ['cpu', '200'], false],
    ['/seti:cpu none', ['cpu', 'none'], false],
    ['/seti:restart', ['restart'], true],
    ['/seti:archive', ['archive'], true],
    ['/seti:dream', ['dream'], false],
    ['/seti:settings access', ['settings', 'access'], false],
    ['/seti:settings', ['settings'], false],
    ['/seti:rules', ['rules'], false],
    ['/seti:role', ['role'], false],
  ] as const)('reads %s', (line, keys, confirm) => {
    const command = parsed(line)
    expect(command.keys).toEqual(keys)
    expect(command.rule.confirm).toBe(confirm)
    expect(command.description).not.toBe('')
  })

  it('writes the canonical line and describes the change in its own words', () => {
    expect(parsed('  /SETI:ACCESS MCP Playwright ON')).toMatchObject({
      line: '/seti:access mcp playwright on',
      description: 'Turn the MCP server playwright on for this agent',
    })
    expect(parsed('/seti:access host docs.example.org add').description).toBe('Let this agent reach docs.example.org')
    expect(parsed('/seti:access pack 5f0e4b1c on').description).toContain('Style guide')
    expect(parsed('/seti:memory 12g').description).toBe("Set this agent's memory cap to 12 GB")
  })

  it.each([
    ['/seti:access mcp playwright', 'needs one of on, off, reset'],
    ['/seti:access mcp github on', 'Already on'],
    ['/seti:access mcp playwright reset', 'Already follows'],
    ['/seti:access mcp sse-only on', 'A transport this runtime lacks'],
    ['/seti:access mcp nowhere on', 'Expected an MCP server, not nowhere'],
    ['/seti:access host api.example.com add', 'Already allowed'],
    ['/seti:access host gone.example.com remove', "Not on this agent's own allowlist"],
    ['/seti:access host localhost add', 'never requestable'],
    ['/seti:access host *.example.com add', 'not a wildcard'],
    ['/seti:access credential Default', 'uses it already'],
    ['/seti:sandbox on', 'Already on'],
    ['/seti:bypass 5', 'Expected one of 2, 8, 24, off, not 5'],
    ['/seti:memory 100m', 'in GB'],
    ['/seti:cpu 64', 'This host has 8 cores'],
    ['/seti:settings nowhere', 'Expected a tab, not nowhere'],
    ['/seti:restart now', 'takes nothing after it'],
    ['/seti:nothing', 'Expected a command, not seti:nothing'],
  ])('refuses %s', (line, reason) => {
    expect(refusal(line)).toContain(reason)
  })

  it.each([
    ['/seti:access mcp playwright on; /seti:sandbox off', 'not on;'],
    ['/seti:access mcp playwright on && rm -rf /', 'takes nothing after it'],
    ['/seti:access mcp playwright on\n/seti:sandbox off', 'one line'],
    ['/seti:access mcp play\u200bwright on', 'invisible'],
    ['/seti:access mcp playwright on\u202e', 'invisible'],
    ['/s\u0435ti:access mcp playwright on', 'starts with /seti:'],
    ['seti:access mcp playwright on', 'starts with /seti:'],
    ['please /seti:access mcp playwright on', 'starts with /seti:'],
    [`/seti:rename ${'x'.repeat(SETI_LINE_MAX)}`, 'at most'],
    ['/seti:access --agent other mcp playwright on', 'Expected a kind of access, not --agent'],
    ['/seti:access mcp playwright on for other-agent', 'takes nothing after it'],
    ['/seti:access mcp other-agent/playwright on', 'Expected an MCP server'],
    ['/seti:access connection OPENAI_API_KEY sk-123', 'Expected a kind of access, not connection'],
  ])('refuses a hostile line: %s', (line, reason) => {
    expect(refusal(line)).toContain(reason)
  })

  it("names the runtime that cannot take a command, from the adapter's capabilities", () => {
    expect(refusal('/seti:access plugin lint-kit on', world('user', 'codex'))).toBe('Not on Codex')
    expect(refusal('/seti:bypass 8', world('user', 'codex'))).toBe('Not on Codex')
    expect(refusal('/seti:sandbox off', { ...world(), sandboxOn: false })).toContain('The sandbox is off in Settings')
  })

  it('checks an agent proposal with the same grammar, for itself alone', () => {
    const agent = world('agent')
    expect(parsed('/seti:access mcp playwright on', agent).rule.propose).toBe(true)
    expect(parsed('/seti:access host docs.example.org add', agent).rule.propose).toBe(true)
    expect(parsed('/seti:memory 12g', agent).rule.propose).toBe(true)
    expect(parsed('/seti:cpu 4', agent).rule.propose).toBe(true)
    expect(parsed('/seti:access ssh prod off', agent).rule.propose).toBe(true)
    expect(refusal('/seti:access ssh staging on', agent)).toBe('Only the user turns this SSH host on')
    expect(refusal('/seti:access aws on', agent)).toBe('Only the user turns AWS on')
    expect(refusal('/seti:access credential Deploy', agent)).toBe('Only the user changes the credential')
    expect(refusal('/seti:access reset', agent)).toBe('Only the user does this')
    for (const line of [
      '/seti:sandbox off',
      '/seti:bypass 8',
      '/seti:control full',
      '/seti:rename Me',
      '/seti:restart',
    ]) {
      expect(parsed(line, agent).rule.propose).toBe(false)
    }
  })
})

describe('Seti command completion', () => {
  const tokens = (text: string, w = world()) => completeSetiLine(text, w)?.options.map((entry) => entry.token)

  it('offers the seti: command for a bare name, so /acc and /mcp still find it', () => {
    expect(tokens('/acc')).toEqual(['seti:access'])
    expect(tokens('/mcp')).toEqual(['seti:mcp'])
    expect(tokens('/seti:re')).toEqual(['seti:restart', 'seti:rename'])
    expect(completeSetiLine('/seti:', world())?.options.length).toBeGreaterThan(20)
  })

  it('completes every step with each choice, its state and why it cannot be picked', () => {
    expect(tokens('/seti:access ')).toEqual([
      'ssh',
      'aws',
      'mcp',
      'plugin',
      'pack',
      'host',
      'home',
      'credential',
      'reset',
      'save',
    ])
    const servers = completeSetiLine('/seti:access mcp ', world())
    expect(servers?.options.map((entry) => [entry.token, entry.detail, entry.unavailable])).toEqual([
      ['playwright', 'Off, Inherited', null],
      ['github', 'On, Custom', null],
      ['sse-only', 'Off, Inherited', 'A transport this runtime lacks'],
    ])
    expect(completeSetiLine('/seti:access ssh pr', world())?.options[0]?.detail).toBe('On, Credential')
    const ops = completeSetiLine('/seti:mcp github ', world())
    expect(ops?.options.map((entry) => [entry.token, entry.unavailable])).toEqual([
      ['on', 'Already on'],
      ['off', null],
      ['reset', null],
    ])
    expect(completeSetiLine('/seti:mcp github o', world())?.from).toBe('/seti:mcp github '.length)
    expect(tokens('/seti:access p', world('user', 'codex'))).toEqual(['plugin', 'pack'])
    expect(completeSetiLine('/seti:access p', world('user', 'codex'))?.options[0]?.unavailable).toBe('Not on Codex')
  })

  it('offers nothing for a message or a line past its last word', () => {
    expect(completeSetiLine('hello /seti:', world())).toBeNull()
    expect(completeSetiLine('/seti:rename New title', world())).toBeNull()
    expect(completeSetiLine('/seti:nothing more', world())).toBeNull()
  })
})
