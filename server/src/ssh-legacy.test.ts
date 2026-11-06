import { describe, expect, it } from 'vitest'
import { parseLegacySshConfig, planSshImport } from './ssh-legacy.js'

const KEYS = [
  { id: 'k1', name: 'voip' },
  { id: 'k2', name: 'experimental-1' },
]

describe('parseLegacySshConfig', () => {
  it('keeps what Seti can render and names what it drops, without values', () => {
    const config = parseLegacySshConfig(
      [
        'User root',
        'Host a b *.corp',
        '  HostName=192.0.2.1',
        '  ProxyCommand nc %h %p',
        '  IdentityFile ~/.ssh/deploy',
        '  ServerAliveInterval 30',
        '  SetEnv TOKEN=secret-value',
        'Match exec "true"',
        '  User nobody',
      ].join('\n'),
    )
    expect(config.blocks).toEqual([
      {
        aliases: ['a', 'b'],
        hostname: '192.0.2.1',
        user: null,
        port: null,
        jumps: [],
        options: [{ name: 'ServerAliveInterval', value: '30' }],
        identityFiles: ['~/.ssh/deploy'],
      },
    ])
    expect(config.dropped).toEqual([
      'line 1: User',
      'line 2: Host patterns or repeated aliases',
      'a: ProxyCommand',
      'a: IdentityFile',
      'a: SetEnv',
      'line 8: Match',
      'line 9: User',
    ])
    expect(JSON.stringify(config)).not.toContain('secret-value')
  })
})

describe('planSshImport', () => {
  it('moves the live config: one host per block and a login guessed by key name, else by elimination', () => {
    const plan = planSshImport(
      'Host voip\n    HostName 198.51.100.170\n    User root\n\nHost gpu-box\n    HostName 203.0.113.54\n    User root',
      KEYS,
      'ubuntu',
    )
    expect(plan.hosts).toEqual([
      { alias: 'voip', hostname: '198.51.100.170', port: 22, jump: null, options: [], user: 'root', keyId: 'k1' },
      { alias: 'gpu-box', hostname: '203.0.113.54', port: 22, jump: null, options: [], user: 'root', keyId: 'k2' },
    ])
    expect(plan.notes).toEqual([
      'voip: the key voip is named after the host',
      'gpu-box: experimental-1 is the only key not named after another host',
    ])
    expect(plan.dropped).toEqual([])
  })

  it('splits multi-alias blocks, shares their key, and falls back to the local user and the first key', () => {
    const plan = planSshImport('Host k8s kube\n  HostName 10.0.0.9\n  Port 2200\n', KEYS, 'ubuntu')
    expect(plan.hosts.map(({ alias, port, user, keyId }) => ({ alias, port, user, keyId }))).toEqual([
      { alias: 'k8s', port: 2200, user: 'ubuntu', keyId: 'k1' },
      { alias: 'kube', port: 2200, user: 'ubuntu', keyId: 'k1' },
    ])
    expect(plan.notes).toEqual(['k8s, kube: no key is named after it, so it got the first key voip'])
  })

  it('uses an IdentityFile naming a key, and the only key without guessing', () => {
    const named = planSshImport('Host box\n  IdentityFile ~/.ssh/experimental-1\n', KEYS, 'ubuntu')
    expect(named.hosts[0]).toMatchObject({ alias: 'box', hostname: 'box', keyId: 'k2' })
    expect(named.notes).toEqual([])
    const single = planSshImport('Host box\n', [{ id: 'only', name: 'main' }], 'ubuntu')
    expect(single.hosts[0]?.keyId).toBe('only')
    expect(single.notes).toEqual([])
    expect(planSshImport('Host box\n', [], 'ubuntu').hosts[0]?.keyId).toBeNull()
  })

  it('turns ProxyJump chains into jump hosts, adding hosts for literal hops and their users', () => {
    const plan = planSshImport(
      [
        'Host jump',
        '  HostName 203.0.113.9',
        'Host k8s',
        '  HostName 192.0.2.9',
        '  User ubuntu',
        '  ProxyJump jump',
        'Host metrics',
        '  HostName 192.0.2.20',
        '  ProxyJump ops@198.51.100.7:2200,k8s',
      ].join('\n'),
      KEYS,
      'me',
    )
    const byAlias = Object.fromEntries(plan.hosts.map((entry) => [entry.alias, entry]))
    expect(byAlias.jump).toMatchObject({ jump: null, user: 'me' })
    expect(byAlias.k8s).toMatchObject({ jump: 'jump', user: 'ubuntu' })
    expect(byAlias.metrics).toMatchObject({ jump: 'k8s', user: 'me' })
    expect(byAlias['198.51.100.7-2200']).toMatchObject({
      hostname: '198.51.100.7',
      port: 2200,
      jump: null,
      user: 'ops',
    })
    expect(plan.notes).toContain('198.51.100.7-2200: added as a host for the ProxyJump ops@198.51.100.7:2200')
    expect(plan.notes).toContain("metrics: kept k8s's own jump jump instead of 198.51.100.7-2200")
  })

  it('chains literal hops that have no jump of their own', () => {
    const plan = planSshImport('Host target\n  HostName 10.1.1.1\n  ProxyJump outer.example,inner.example\n', [], 'me')
    expect(plan.hosts.map(({ alias, jump }) => [alias, jump])).toEqual([
      ['target', 'inner.example'],
      ['outer.example', null],
      ['inner.example', 'outer.example'],
    ])
  })
})
