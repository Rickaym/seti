import { checkSshOption, sshHostFields } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import {
  checkJump,
  firstHop,
  hostMap,
  reachKeys,
  sandboxSshConfig,
  sshChain,
  sshReach,
  sshRoute,
} from './ssh-config.js'
import { renderHosts } from './ssh-files.js'
import type { SshHostRow } from './store/ssh.js'

const host = (alias: string, hostname: string, port = 22, jump: string | null = null): SshHostRow => ({
  alias,
  hostname,
  port,
  user: 'ops',
  key_id: `key-${alias}`,
  jump,
  options: [],
  created_at: 'x',
  updated_at: 'x',
})

const HOSTS = [
  host('bastion', '203.0.113.9', 2222),
  host('k8s', '192.0.2.9', 22, 'bastion'),
  host('metrics', '192.0.2.20', 22, 'k8s'),
  host('db', '198.51.100.7'),
]
const rows = hostMap(HOSTS)

const keyless = (alias: string) => HOSTS.map((entry) => (entry.alias === alias ? { ...entry, key_id: null } : entry))

describe('jump chains', () => {
  it('walks a chain outward and routes through its first hop', () => {
    expect(sshChain(rows, 'metrics').map((entry) => entry.alias)).toEqual(['metrics', 'k8s', 'bastion'])
    expect(sshRoute(rows, 'metrics')).toBe('192.0.2.20:22 via bastion, k8s')
    expect(sshRoute(rows, 'db')).toBe('198.51.100.7:22')
    expect(firstHop(rows, 'metrics')).toBe('203.0.113.9:2222')
  })

  it('refuses a jump host that is missing, the host itself, or one that would loop', () => {
    expect(() => {
      checkJump(rows, 'db', 'nowhere')
    }).toThrow('No ssh host nowhere')
    expect(() => {
      checkJump(rows, 'db', 'db')
    }).toThrow('cannot jump through itself')
    expect(() => {
      checkJump(rows, 'bastion', 'metrics')
    }).toThrow('metrics already connects through bastion')
    expect(() => {
      checkJump(rows, 'db', 'metrics')
    }).not.toThrow()
  })
})

describe('sshReach', () => {
  it('makes a granted host usable with its jump hosts, each with its own key', () => {
    const reach = sshReach(keyless('metrics'), ['k8s', 'metrics', 'db'])
    expect(reach.enabled).toEqual(['k8s', 'metrics', 'db'])
    expect(reach.usable).toEqual(['k8s', 'db'])
    expect(reach.missing.get('metrics')).toEqual(['metrics'])
    expect(reach.missing.get('k8s')).toEqual([])
    expect(reach.hosts.map((entry) => entry.alias)).toEqual(['bastion', 'k8s', 'db'])
    expect(reachKeys(reach.hosts)).toEqual(['key-bastion', 'key-k8s', 'key-db'])
    expect(reach.jumpFor.get('bastion')).toEqual(['k8s'])
    expect(reach.firstHops).toEqual(['203.0.113.9:2222', '198.51.100.7:22'])
    expect(reach.knownHosts).toEqual(new Set(['[203.0.113.9]:2222', '192.0.2.9', '198.51.100.7']))
  })

  it('leaves a host whose jump host has no key unusable, and offers none of its keys', () => {
    const reach = sshReach(keyless('bastion'), ['metrics'])
    expect(reach.usable).toEqual([])
    expect(reach.missing.get('metrics')).toEqual(['bastion'])
    expect(reach.hosts).toEqual([])
    expect(reach.firstHops).toEqual([])
    expect(reach.knownHosts).toEqual(new Set())
  })

  it('gives nothing without a grant, and offers a key shared by hosts once', () => {
    expect(sshReach(HOSTS, []).hosts).toEqual([])
    const shared = HOSTS.map((entry) => ({ ...entry, key_id: 'one' }))
    expect(reachKeys(sshReach(shared, ['metrics', 'db']).hosts)).toEqual(['one'])
  })
})

describe('sandboxSshConfig', () => {
  it("pins each host's user and key, sends first hops through the proxy and pins host keys", () => {
    const list = HOSTS.map((entry) =>
      entry.alias === 'k8s'
        ? { ...entry, user: 'ubuntu', options: [{ name: 'ServerAliveInterval', value: '30' }] }
        : { ...entry, key_id: entry.alias === 'bastion' ? 'shared' : entry.key_id },
    )
    const reach = sshReach(list, ['k8s'])
    const config = sandboxSshConfig(renderHosts(reach.hosts, '/home/me/.ssh'), {
      proxy: { socat: '/usr/bin/socat', port: 3128 },
      knownHosts: '/home/me/.ssh/known_hosts',
    })
    expect(config).toBe(
      [
        'Host bastion',
        '  HostName 203.0.113.9',
        '  Port 2222',
        '  User ops',
        '  IdentityFile /home/me/.ssh/seti-shared.pub',
        '  IdentitiesOnly yes',
        '',
        'Host k8s',
        '  HostName 192.0.2.9',
        '  Port 22',
        '  User ubuntu',
        '  IdentityFile /home/me/.ssh/seti-key-k8s.pub',
        '  IdentitiesOnly yes',
        '  ProxyJump bastion',
        '  ServerAliveInterval 30',
        '',
        'Host *',
        '  ProxyCommand /usr/bin/socat - PROXY:127.0.0.1:%h:%p,proxyport=3128',
        '  UserKnownHostsFile /home/me/.ssh/known_hosts',
        '  GlobalKnownHostsFile /dev/null',
        '  StrictHostKeyChecking yes',
        '  UpdateHostKeys no',
        '  BatchMode yes',
        '  IdentitiesOnly yes',
        '  ForwardAgent no',
        '  ControlMaster no',
        '  ConnectTimeout 10',
        '  ServerAliveInterval 15',
        '  ServerAliveCountMax 3',
        '',
      ].join('\n'),
    )
    expect(config).not.toContain('metrics')
    expect(config).not.toContain('db')
  })
})

const LOGIN = { user: 'ops', key_id: 'k1' }

describe('extra ssh options', () => {
  it('keeps the allowed ones, spelled as ssh does', () => {
    expect(checkSshOption('serveraliveinterval', ' 30 ')).toEqual({
      ok: true,
      option: { name: 'ServerAliveInterval', value: '30' },
    })
    expect(checkSshOption('PubkeyAcceptedAlgorithms', '+ssh-rsa')).toMatchObject({ ok: true })
    expect(checkSshOption('Compression', 'maybe')).toEqual({ ok: false, problem: 'Compression maybe is not valid' })
  })

  it.each([
    ['ProxyCommand', 'nc %h %p', 'runs commands on this machine'],
    ['LocalCommand', 'touch ~/x', 'runs commands'],
    ['PermitLocalCommand', 'yes', 'runs commands'],
    ['Match', 'exec true', 'runs commands'],
    ['Include', '~/.ssh/other', 'reads other files'],
    ['IdentityAgent', '~/agent', 'is managed by Seti'],
    ['IdentityFile', '~/.ssh/id_ed25519', 'has its own field: Key'],
    ['CertificateFile', '~/.ssh/cert', 'is managed by Seti'],
    ['ControlPath', '~/cm', 'forwards sockets'],
    ['LocalForward', '5432 db:5432', 'forwards sockets'],
    ['StrictHostKeyChecking', 'no', 'is managed by Seti'],
    ['User', 'root', 'has its own field: User'],
    ['ProxyJump', 'evil', 'has its own field'],
    ['KnownHostsCommand', '/bin/true', 'runs commands'],
    ['SetEnv', 'FOO=bar', 'passes environment'],
    ['VisualHostKey', 'yes', 'VisualHostKey is not supported'],
  ])('refuses %s', (name, value, problem) => {
    const result = checkSshOption(name, value)
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.problem).toContain(problem)
  })

  it('refuses values with spaces, tokens or quotes, and an option set twice', () => {
    expect(checkSshOption('Ciphers', 'aes128-ctr %h').ok).toBe(false)
    expect(checkSshOption('ConnectTimeout', '"5"').ok).toBe(false)
    const twice = sshHostFields.safeParse({
      ...LOGIN,
      hostname: 'a.example',
      options: [
        { name: 'ConnectTimeout', value: '5' },
        { name: 'connecttimeout', value: '6' },
      ],
    })
    expect(twice.error?.issues[0]?.message).toBe('ConnectTimeout is set twice')
    const parsed = sshHostFields.parse({
      ...LOGIN,
      hostname: 'a.example',
      options: [{ name: 'tcpkeepalive', value: 'yes' }],
    })
    expect(parsed).toEqual({
      hostname: 'a.example',
      port: 22,
      user: 'ops',
      key_id: 'k1',
      jump: null,
      options: [{ name: 'TCPKeepAlive', value: 'yes' }],
    })
  })

  it('refuses host names with users, ports or shell characters, and a host without a user or key', () => {
    expect(sshHostFields.safeParse({ ...LOGIN, hostname: 'root@a.example' }).success).toBe(false)
    expect(sshHostFields.safeParse({ ...LOGIN, hostname: 'a.example:22' }).success).toBe(false)
    expect(sshHostFields.safeParse({ ...LOGIN, hostname: '$(id)' }).success).toBe(false)
    expect(sshHostFields.safeParse({ ...LOGIN, hostname: 'a.example', port: 70_000 }).success).toBe(false)
    expect(sshHostFields.safeParse({ ...LOGIN, hostname: 'a.example', user: 'a b' }).success).toBe(false)
    expect(sshHostFields.safeParse({ hostname: 'a.example', user: 'ops' }).error?.issues[0]?.path).toEqual(['key_id'])
  })
})
