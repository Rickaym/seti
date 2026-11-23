import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { projectSlug, sandboxMounts, type Mount, type SandboxLayout } from './sandbox-mounts.js'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'seti-read-only-')))
const home = path.join(root, 'home')
const make = (...parts: string[]) => {
  const dir = path.join(...parts)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

const setiHome = make(home, '.seti')
const claudeHome = make(home, '.claude')
fs.writeFileSync(path.join(claudeHome, 'settings.json'), '{}')
make(home, '.npm')
const cwd = make(home, 'scratch', 'agent-1')
const extra = make(home, 'scratch', 'agent-1-extra')
const checkout = make(home, 'scratch', 'agent-1', 'app')
make(checkout, '.git')
fs.writeFileSync(path.join(checkout, '.git', 'config'), '')
const workspace = make(setiHome, 'workspace', 'task-1')
const night = make(workspace, 'dreams', '2026-11-23')
const secret = make(home, 'secret')
const taskDir = make(setiHome, 'sandbox', 'task-1', 'maintenance')

const layout = (patch: Partial<SandboxLayout> = {}, maintenance = true): SandboxLayout => ({
  home,
  setiHome,
  worktreeRoot: path.join(setiHome, 'worktrees'),
  claudeHome,
  taskDir,
  cwd,
  dirs: [extra],
  ownRoot: path.join(home, 'scratch'),
  workspace,
  readOnly: [],
  caDir: make(setiHome, 'sandbox-ca', 'public'),
  systemBundle: null,
  hidden: [secret],
  pathEnv: '/usr/bin:/bin',
  sessionId: null,
  ...(maintenance ? { maintenance: { writable: [night] } } : {}),
  ...patch,
})

const find = (mounts: readonly Mount[], dest: string) => mounts.find((mount) => mount.dest === dest)
const slug = path.join('projects', projectSlug(cwd))
const project = path.join('.claude', slug)

describe('a maintenance sandbox', () => {
  const mounts = sandboxMounts(layout())
  const agent = sandboxMounts(layout({}, false))

  it('binds every work folder, cache and the workspace read-only', () => {
    for (const dir of [cwd, extra, workspace, path.join(home, '.npm'), path.join(home, project)]) {
      expect(find(agent, dir)?.kind).toBe('bind')
      expect(find(mounts, dir)?.kind).toBe('ro-bind')
    }
  })

  it('binds only its own memory folder and the named folders writable, after their parents', () => {
    const memory = path.join(home, project, 'memory')
    expect(find(mounts, memory)).toEqual({ kind: 'bind', src: path.join(claudeHome, slug, 'memory'), dest: memory })
    expect(find(mounts, night)).toEqual({ kind: 'bind', src: night, dest: night })
    expect(fs.existsSync(path.join(claudeHome, slug, 'memory'))).toBe(true)
    const writable = mounts.filter((mount) => mount.kind === 'bind').map((mount) => mount.dest)
    expect(new Set(writable)).toEqual(new Set([home, '/tmp', memory, night]))
    const order = mounts.map((mount) => mount.dest)
    expect(order.indexOf(memory)).toBeGreaterThan(order.indexOf(path.join(home, project)))
    expect(order.indexOf(night)).toBeGreaterThan(order.indexOf(workspace))
  })

  it("keeps its private home and /tmp in its own state folder, apart from the agent's", () => {
    expect(find(mounts, '/tmp')).toEqual({ kind: 'bind', src: path.join(taskDir, 'tmp'), dest: '/tmp' })
    expect(find(mounts, home)).toEqual({ kind: 'bind', src: path.join(taskDir, 'home'), dest: home })
  })

  it('refuses a writable folder under a hidden path or given relative', () => {
    expect(() => sandboxMounts(layout({ maintenance: { writable: [path.join(secret, 'x')] } }))).toThrow(/cannot write/)
    expect(() => sandboxMounts(layout({ maintenance: { writable: ['dreams'] } }))).toThrow(/cannot write/)
  })
})
