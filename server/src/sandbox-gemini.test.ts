import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { GEMINI_CONFIG_MOUNT, geminiLocks, prepareGemini } from './sandbox-gemini.js'
import { sandboxMounts, type Mount, type SandboxLayout } from './sandbox-mounts.js'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'seti-gemini-mounts-')))
const make = (...parts: string[]) => {
  const dir = path.join(...parts)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}
const home = make(root, 'home')
const setiHome = make(home, '.seti')
const claudeHome = make(home, '.claude')
const repo = make(home, 'code', 'app')
const extra = make(home, 'code', 'docs')
const taskDir = make(setiHome, 'sandbox', 'task-1')

const layout = (patch: Partial<SandboxLayout> = {}): SandboxLayout => ({
  home,
  setiHome,
  worktreeRoot: path.join(setiHome, 'worktrees'),
  claudeHome,
  taskDir,
  cwd: repo,
  dirs: [extra],
  readOnly: [],
  caDir: make(setiHome, 'sandbox-ca'),
  systemBundle: null,
  browserDb: null,
  hidden: [],
  pathEnv: '/usr/bin:/bin',
  sessionId: null,
  gemini: true,
  ...patch,
})

const find = (mounts: Mount[], dest: string) => mounts.filter((mount) => 'dest' in mount && mount.dest === dest)
const empty = path.join(taskDir, 'empty')
const blank = path.join(taskDir, 'empty-file')

describe("a Gemini CLI agent's mounts", () => {
  it("leave out Claude Code's configuration and cover Gemini CLI's settings, trust and hooks", () => {
    const mounts = sandboxMounts(layout())
    expect(mounts.filter((mount) => 'dest' in mount && mount.dest.startsWith(claudeHome))).toEqual([])
    for (const name of ['settings.json', 'trustedFolders.json', 'trusted_hooks.json']) {
      const dest = path.join(home, '.gemini', name)
      expect(find(mounts, dest)).toEqual([{ kind: 'ro-bind', src: path.join(taskDir, 'empty.json'), dest }])
    }
  })

  it('cover the variables, system prompt, policies, extensions, skills, agents and startup files', () => {
    const mounts = sandboxMounts(layout())
    const files = [
      ...['.env', 'system.md', 'GEMINI.md'].map((name) => path.join(home, '.gemini', name)),
      ...['.env', '.bashrc', '.profile', '.zshenv'].map((name) => path.join(home, name)),
    ]
    for (const dest of files) {
      expect(find(mounts, dest)).toEqual([{ kind: 'ro-bind', src: blank, dest }])
    }
    const dirs = [
      ...['policies', 'extensions', 'skills', 'agents', 'commands', 'bin'].map((name) =>
        path.join(home, '.gemini', name),
      ),
      path.join(home, '.agents'),
    ]
    for (const dest of dirs) {
      expect(find(mounts, dest)).toEqual([{ kind: 'ro-bind', src: empty, dest }])
    }
  })

  it("cover each working folder's own .gemini folder after the folder itself is mounted", () => {
    const mounts = sandboxMounts(layout())
    for (const dir of [repo, extra]) {
      const dest = path.join(dir, '.gemini')
      expect(find(mounts, dest)).toEqual([{ kind: 'ro-bind', src: empty, dest }])
      const order = mounts.map((mount) => ('dest' in mount ? mount.dest : ''))
      expect(order.indexOf(dest)).toBeGreaterThan(order.indexOf(dir))
    }
  })

  it("show Seti's settings and policy read-only, and cover the machine's own only where it has them", () => {
    const mounts = geminiLocks(layout(), path.join(root, 'none'))
    expect(find(mounts, GEMINI_CONFIG_MOUNT)).toEqual([
      { kind: 'ro-bind', src: path.join(taskDir, 'gemini-config'), dest: GEMINI_CONFIG_MOUNT },
    ])
    expect(find(mounts, path.join(root, 'none'))).toEqual([])
    const hostConfig = make(root, 'etc-gemini-cli')
    expect(find(geminiLocks(layout(), hostConfig), hostConfig)).toEqual([
      { kind: 'ro-bind', src: empty, dest: hostConfig },
    ])
  })

  it("give Gemini CLI the user's own CLAUDE.md, read-only, but none in a bare session", () => {
    const own = make(root, 'claude-home-with-instructions')
    fs.writeFileSync(path.join(own, 'CLAUDE.md'), 'USER_INSTRUCTIONS')
    const dest = path.join(home, '.gemini', 'GEMINI.md')
    expect(find(geminiLocks(layout({ claudeHome: own })), dest)).toEqual([
      { kind: 'ro-bind', src: path.join(own, 'CLAUDE.md'), dest },
    ])
    const bare = layout({ claudeHome: own, maintenance: { writable: [], bare: true } })
    expect(find(geminiLocks(bare), dest)).toEqual([{ kind: 'ro-bind', src: blank, dest }])
  })
})

describe("a Gemini CLI agent's prepared state", () => {
  it("writes Seti's files and the covers, and makes the mount points in the home", () => {
    const dir = make(root, 'prepared')
    const work = { cwd: make(root, 'work-a'), dirs: [] }
    prepareGemini(dir, work)
    const settings = JSON.parse(fs.readFileSync(path.join(dir, 'gemini-config', 'settings.json'), 'utf8')) as {
      advanced: { ignoreLocalEnv: boolean }
      security: { disableYoloMode: boolean; disableAlwaysAllow: boolean }
    }
    expect(settings.advanced.ignoreLocalEnv).toBe(true)
    expect(settings.security).toMatchObject({ disableYoloMode: true, disableAlwaysAllow: true })
    expect(fs.readFileSync(path.join(dir, 'gemini-config', 'seti-policy.toml'), 'utf8')).toContain('ask_user')
    expect(fs.readFileSync(path.join(dir, 'empty.json'), 'utf8')).toBe('{}\n')
    expect(fs.readFileSync(path.join(dir, 'empty-file'), 'utf8')).toBe('')
    expect(fs.statSync(path.join(dir, 'home', '.gemini', 'policies')).isDirectory()).toBe(true)
    expect(fs.statSync(path.join(dir, 'home', '.gemini', 'settings.json')).isFile()).toBe(true)
  })

  it('gives a working folder an empty .gemini folder and leaves one that is there alone', () => {
    const fresh = make(root, 'work-fresh')
    const shipped = make(root, 'work-shipped', '.gemini')
    fs.writeFileSync(path.join(shipped, 'settings.json'), '{"mcpServers":{}}')
    const linked = make(root, 'work-linked')
    fs.symlinkSync(path.join(root, 'nowhere'), path.join(linked, '.gemini'))
    prepareGemini(make(root, 'prepared-2'), { cwd: fresh, dirs: [path.dirname(shipped), linked] })
    expect(fs.readdirSync(path.join(fresh, '.gemini'))).toEqual([])
    expect(fs.readdirSync(shipped)).toEqual(['settings.json'])
    expect(fs.lstatSync(path.join(linked, '.gemini')).isSymbolicLink()).toBe(true)
  })
})
