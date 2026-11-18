import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { SANDBOX_POLICY_DEFAULT } from '@seti/shared'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { removeTaskFiles } from './archive-files.js'
import { binaryPath } from './binaries.js'
import {
  createCapabilityCache,
  idlePrompt,
  probe,
  probeEnv,
  setProbeLauncher,
  type StartProbe,
} from './capabilities.js'
import { sql, tasks } from './db.js'
import { sandboxedProbeLaunch } from './probe-launch.js'
import { sandboxPolicy } from './store/sandbox.js'
import { removeTaskSandbox } from './task-sandbox.js'

const root = await vi.hoisted(async () => {
  const { mkdtempSync, realpathSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const nodePath = await import('node:path')
  const dir = realpathSync(mkdtempSync(nodePath.join(tmpdir(), 'seti-probe-hostile-')))
  process.env.HOME = nodePath.join(dir, 'home')
  process.env.SETI_HOME = nodePath.join(dir, 'home', '.seti')
  process.env.SETI_CLAUDE_HOME = nodePath.join(dir, 'home', '.claude')
  return dir
})

const home = path.join(root, 'home')
const available = binaryPath('bwrap') !== null && binaryPath('socat') !== null
const TIMING = { pollMs: 200, pendingCapMs: 8000, callTimeoutMs: 30_000 }

/** A folder whose project settings and `.mcp.json` each write the hostname they ran on. */
function hostileFolder(name: string, serverSeconds = 2): { dir: string; ran: () => Record<string, string> } {
  const dir = path.join(home, name)
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true })
  const mark = (what: string) => `hostname > ${path.join(dir, what)}-ran`
  const hook = { hooks: [{ type: 'command', command: mark('hook') }] }
  fs.writeFileSync(
    path.join(dir, '.claude', 'settings.json'),
    JSON.stringify({ hooks: { SessionStart: [hook], Setup: [hook] }, enableAllProjectMcpServers: true }),
  )
  const server = { command: 'sh', args: ['-c', `${mark('mcp')}; sleep ${String(serverSeconds)}`] }
  fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { planted: server } }))
  const ran = () =>
    Object.fromEntries(
      fs
        .readdirSync(dir)
        .filter((file) => file.endsWith('-ran'))
        .map((file) => [file.replace(/-ran$/, ''), fs.readFileSync(path.join(dir, file), 'utf8').trim()]),
    )
  return { dir, ran }
}

const hostStart: StartProbe = (cwd, signal) =>
  query({ prompt: idlePrompt(signal), options: { cwd, settingSources: ['user', 'project', 'local'], env: probeEnv() } })

describe.skipIf(!available)('the capability probe of a folder a sandboxed agent can write', () => {
  beforeAll(async () => {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
    await sandboxPolicy.save(SANDBOX_POLICY_DEFAULT)
    setProbeLauncher(sandboxedProbeLaunch)
  })

  afterAll(async () => {
    await removeTaskSandbox('probe-worker')
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('would run what the folder configures when probed on the host, which is what the launcher prevents', async () => {
    const control = hostileFolder('control')
    await probe(control.dir, hostStart, TIMING)
    expect(control.ran()).toEqual({ hook: os.hostname(), mcp: os.hostname() })
  }, 60_000)

  it('runs inside the sandbox of the agent that works there', async () => {
    const folder = hostileFolder('project')
    await tasks.insert({
      id: 'probe-worker',
      title: 'Probe worker',
      repo_id: null,
      cwd: folder.dir,
      worktree: false,
      pr_urls: [],
    })
    const snapshot = await createCapabilityCache(undefined, TIMING).get(folder.dir)
    expect(folder.ran()).toEqual({ hook: 'seti-sandbox', mcp: 'seti-sandbox' })
    expect(snapshot.servers.map((server) => server.name)).toContain('planted')
  }, 90_000)

  it('ends a probe that still runs in the sandbox before the agent is deleted', async () => {
    const folder = hostileFolder('deleted', 60)
    const task = { id: 'probe-deleted', title: 'Deleted', repo_id: null, cwd: folder.dir, worktree: false, pr_urls: [] }
    await tasks.insert(task)
    const probing = createCapabilityCache(undefined, TIMING)
      .get(folder.dir)
      .then(
        () => 'finished',
        () => 'ended',
      )
    await vi.waitFor(() => {
      expect(folder.ran()).toMatchObject({ mcp: 'seti-sandbox' })
    })
    const stored = await tasks.get(task.id)
    if (stored === undefined) {
      throw new Error('Task was not stored')
    }
    await removeTaskFiles(stored)
    expect(await probing).toBe('ended')
    expect(fs.existsSync(path.join(home, '.seti', 'sandbox', task.id))).toBe(false)
  }, 90_000)

  it("reads only the user's settings in another folder such an agent can write, so nothing there runs", async () => {
    const extra = hostileFolder('notes')
    const nested = path.join(extra.dir, 'nested')
    fs.mkdirSync(nested)
    await sql`INSERT INTO task_dir (task_id, dir) VALUES ('probe-worker', ${extra.dir})`
    expect(await sandboxedProbeLaunch(extra.dir)).toEqual({ settingSources: ['user'] })
    expect(await sandboxedProbeLaunch(nested)).toEqual({ settingSources: ['user'] })
    const snapshot = await createCapabilityCache(undefined, TIMING).get(extra.dir)
    expect(extra.ran()).toEqual({})
    expect(snapshot.servers.map((server) => server.name)).not.toContain('planted')
  }, 60_000)

  it('keeps reading only user settings once the agent is archived, and probes other folders as before', async () => {
    const left = hostileFolder('archived')
    await tasks.insert({
      id: 'probe-archived',
      title: 'Archived',
      repo_id: null,
      cwd: left.dir,
      worktree: false,
      pr_urls: [],
    })
    await sql`UPDATE task SET archived_at = ${new Date().toISOString()} WHERE id = 'probe-archived'`
    expect(await sandboxedProbeLaunch(left.dir)).toEqual({ settingSources: ['user'] })

    const own = hostileFolder('unsandboxed')
    await tasks.insert({
      id: 'probe-host',
      title: 'On the host',
      repo_id: null,
      cwd: own.dir,
      worktree: false,
      pr_urls: [],
      sandbox: false,
    })
    expect(await sandboxedProbeLaunch(own.dir)).toBeNull()
    expect(await sandboxedProbeLaunch(path.join(home, 'elsewhere'))).toBeNull()
    expect(await sandboxedProbeLaunch(home)).toBeNull()

    await sandboxPolicy.save({ ...SANDBOX_POLICY_DEFAULT, enabled: false })
    expect(await sandboxedProbeLaunch(left.dir)).toBeNull()
    await sandboxPolicy.save(SANDBOX_POLICY_DEFAULT)
  })
})
