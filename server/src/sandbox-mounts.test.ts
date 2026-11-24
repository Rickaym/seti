import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { bwrapArgs } from './sandbox-bwrap.js'
import { sandboxClaudeJson, sandboxServers } from './sandbox-claude-json.js'
import { codexLocks } from './sandbox-codex.js'
import {
  canonicalRoot,
  mountProblem,
  projectSlug,
  SANDBOX_CA,
  SANDBOX_RUN,
  sandboxMounts,
  type Mount,
  type SandboxLayout,
  WORK_DIR,
} from './sandbox-mounts.js'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'seti-mounts-')))
const home = path.join(root, 'home')
const make = (...parts: string[]) => {
  const dir = path.join(...parts)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}
const touch = (file: string, text = '') => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
  return file
}

const setiHome = make(home, '.seti')
const claudeHome = make(home, '.claude')
touch(path.join(claudeHome, '.credentials.json'), '{}')
touch(path.join(claudeHome, 'settings.json'), '{}')
touch(path.join(claudeHome, 'history.jsonl'))
make(claudeHome, 'skills', 'mine')
make(claudeHome, 'plugins', 'cache')
make(claudeHome, 'projects', 'other-project')
make(home, '.ssh')
make(home, '.nvm', 'versions')
make(home, '.npm')
make(home, '.cargo', 'bin')
touch(path.join(home, '.cargo', 'credentials.toml'))
touch(path.join(home, '.gitconfig'))

const repo = make(home, 'code', 'app')
make(repo, '.git', 'hooks')
touch(path.join(repo, '.git', 'config'))
touch(path.join(repo, '.env.secret'))
const mainRepo = make(home, 'code', 'main')
const commonGit = make(mainRepo, '.git')
touch(path.join(commonGit, 'config'))
const worktree = make(setiHome, 'worktrees', 'task-1')
const worktreeGit = make(commonGit, 'worktrees', 'task-1')
touch(path.join(worktree, '.git'), `gitdir: ${worktreeGit}\n`)
touch(path.join(worktreeGit, 'commondir'), '../..\n')
touch(path.join(worktreeGit, 'gitdir'), `${path.join(worktree, '.git')}\n`)
const otherTask = make(setiHome, 'worktrees', 'task-2')
const otherAdmin = make(commonGit, 'worktrees', 'task-2')
touch(path.join(otherTask, '.git'), `gitdir: ${otherAdmin}\n`)
touch(path.join(otherAdmin, 'gitdir'), `${path.join(otherTask, '.git')}\n`)
const branchCheckout = make(home, 'main-feature')
const branchAdmin = make(commonGit, 'worktrees', 'main-feature')
touch(path.join(branchCheckout, '.git'), `gitdir: ${branchAdmin}\n`)
touch(path.join(branchAdmin, 'gitdir'), `${path.join(branchCheckout, '.git')}\n`)
touch(path.join(branchAdmin, 'commondir'), '../..\n')
const liveCheckout = make(home, 'seti-live')
touch(path.join(home, 'backup.key'), 'key')
touch(path.join(home, '.zshrc'))

const taskDir = make(setiHome, 'sandbox', 'task-1')
const caDir = make(setiHome, 'sandbox-ca', 'public')

const layout = (patch: Partial<SandboxLayout> = {}): SandboxLayout => ({
  home,
  setiHome,
  worktreeRoot: path.join(setiHome, 'worktrees'),
  claudeHome,
  taskDir,
  cwd: repo,
  dirs: [],
  homeAccess: true,
  readOnly: [],
  caDir,
  systemBundle: '/etc/ssl/certs/ca-certificates.crt',
  hidden: [
    path.join(home, '.ssh'),
    path.join(home, '.cargo', 'credentials.toml'),
    path.join(repo, '.env.secret'),
    liveCheckout,
  ],
  pathEnv: `${path.join(home, '.cargo', 'bin')}:/usr/bin:/bin`,
  sessionId: null,
  ...patch,
})

const dests = (mounts: readonly Mount[], kind?: Mount['kind']) =>
  mounts.filter((mount) => kind === undefined || mount.kind === kind).map((mount) => mount.dest)
const find = (mounts: readonly Mount[], dest: string) => mounts.filter((mount) => mount.dest === dest)

describe('sandboxMounts', () => {
  const mounts = sandboxMounts(layout())

  it('mounts the system read-only and gives the task its own home and /tmp', () => {
    expect(mounts.slice(0, 2)).toEqual([
      { kind: 'ro-bind', src: '/usr', dest: '/usr' },
      { kind: 'ro-bind', src: '/etc', dest: '/etc' },
    ])
    expect(find(mounts, '/tmp')).toEqual([{ kind: 'bind', src: path.join(taskDir, 'tmp'), dest: '/tmp' }])
    expect(find(mounts, home)).toEqual([{ kind: 'bind', src: path.join(taskDir, 'home'), dest: home }])
    expect(find(mounts, '/run')).toEqual([{ kind: 'tmpfs', dest: '/run' }])
  })

  it('binds the task workspace at its host path, so attachment paths hold inside the sandbox', () => {
    const workspace = make(setiHome, 'workspace', 'task-1')
    const uploads = path.join(workspace, 'uploads', 'report.pdf')
    const mounted = find(sandboxMounts(layout({ workspace })), workspace)
    expect(mounted).toEqual([{ kind: 'bind', src: workspace, dest: workspace }])
    expect(uploads.startsWith(`${mounted[0]?.dest ?? ''}/`)).toBe(true)
  })

  it('binds the task directory and caches writable, toolchains read-only', () => {
    expect(find(mounts, repo)).toEqual([{ kind: 'bind', src: repo, dest: repo }])
    expect(find(mounts, path.join(home, '.npm'))[0]?.kind).toBe('bind')
    expect(find(mounts, path.join(home, '.nvm'))[0]?.kind).toBe('ro-bind')
    expect(find(mounts, path.join(home, '.cargo', 'bin'))[0]?.kind).toBe('ro-bind')
    expect(find(mounts, path.join(home, '.gitconfig'))[0]?.kind).toBe('ro-bind')
  })

  it('never mounts credentials, Seti state or other sessions', () => {
    const sources = mounts.flatMap((mount) => ('src' in mount ? [mount.src] : []))
    for (const secret of [
      setiHome,
      path.join(home, '.ssh'),
      path.join(home, '.cargo'),
      path.join(claudeHome, '.credentials.json'),
      path.join(claudeHome, 'history.jsonl'),
      path.join(claudeHome, 'projects'),
      path.join(claudeHome, 'projects', 'other-project'),
    ]) {
      expect(sources).not.toContain(secret)
    }
    const setiSources = sources.filter((src) => src.startsWith(`${setiHome}/`))
    expect(setiSources.filter((src) => !src.startsWith(`${taskDir}/`) && !src.startsWith(caDir))).toEqual([])
  })

  it("mounts Claude Code's config read-only and this directory's sessions writable", () => {
    const inside = path.join(home, '.claude')
    expect(find(mounts, path.join(inside, 'settings.json'))).toEqual([
      { kind: 'ro-bind', src: path.join(claudeHome, 'settings.json'), dest: path.join(inside, 'settings.json') },
    ])
    expect(find(mounts, path.join(inside, 'skills'))[0]?.kind).toBe('ro-bind')
    expect(find(mounts, path.join(inside, 'plugins', 'data'))).toEqual([
      { kind: 'bind', src: path.join(taskDir, 'plugin-data'), dest: path.join(inside, 'plugins', 'data') },
    ])
    expect(fs.existsSync(path.join(claudeHome, 'plugins', 'data'))).toBe(true)
    const project = path.join('projects', projectSlug(repo))
    expect(find(mounts, path.join(inside, project))).toEqual([
      { kind: 'bind', src: path.join(claudeHome, project), dest: path.join(inside, project) },
    ])
    expect(fs.existsSync(path.join(claudeHome, project))).toBe(true)
  })

  it('keeps the checkpoints of a resumed session from before the sandbox', () => {
    const history = make(claudeHome, 'file-history', 'session-1')
    const resumed = sandboxMounts(layout({ sessionId: 'session-1' }))
    expect(find(resumed, path.join(home, '.claude', 'file-history', 'session-1'))).toEqual([
      { kind: 'bind', src: history, dest: path.join(home, '.claude', 'file-history', 'session-1') },
    ])
    expect(dests(sandboxMounts(layout({ sessionId: 'session-2' }))).some((dest) => dest.includes('session-2'))).toBe(
      false,
    )
  })

  it('covers git config and hooks read-only, since they run code on the host', () => {
    const guards = mounts.slice(mounts.findIndex((mount) => mount.dest === repo))
    expect(guards).toEqual(
      expect.arrayContaining([
        { kind: 'ro-bind', src: path.join(repo, '.git', 'config'), dest: path.join(repo, '.git', 'config') },
        { kind: 'ro-bind', src: path.join(repo, '.git', 'hooks'), dest: path.join(repo, '.git', 'hooks') },
      ]),
    )
  })

  it("binds a worktree's shared .git writable and guards its pointer file", () => {
    const wt = sandboxMounts(layout({ cwd: worktree }))
    expect(find(wt, commonGit)).toEqual([{ kind: 'bind', src: commonGit, dest: commonGit }])
    expect(dests(wt, 'ro-bind')).toEqual(
      expect.arrayContaining([
        path.join(commonGit, 'config'),
        path.join(commonGit, 'hooks'),
        path.join(worktree, '.git'),
      ]),
    )
    expect(fs.existsSync(path.join(commonGit, 'hooks'))).toBe(true)
    expect(dests(wt)).not.toContain(path.join(setiHome, 'worktrees'))
  })

  it('follows a .git file only to a repository that records the folder as its worktree or submodule', () => {
    const foreign = make(root, 'elsewhere', 'repo')
    const foreignGit = make(foreign, '.git')
    touch(path.join(foreignGit, 'config'))
    const direct = make(home, 'code', 'forged-direct')
    touch(path.join(direct, '.git'), `gitdir: ${foreignGit}\n`)
    const viaAdmin = make(home, 'code', 'forged-admin')
    const admin = make(home, 'code', 'forged-admin-state')
    touch(path.join(viaAdmin, '.git'), `gitdir: ${admin}\n`)
    touch(path.join(admin, 'commondir'), `${foreignGit}\n`)
    touch(path.join(admin, 'gitdir'), `${path.join(viaAdmin, '.git')}\n`)
    const unrecorded = make(home, 'code', 'forged-unrecorded')
    const stale = make(foreignGit, 'worktrees', 'someone-else')
    touch(path.join(unrecorded, '.git'), `gitdir: ${stale}\n`)
    touch(path.join(stale, 'commondir'), '../..\n')
    touch(path.join(stale, 'gitdir'), `${path.join(root, 'elsewhere', 'their-worktree', '.git')}\n`)
    for (const forged of [direct, viaAdmin, unrecorded]) {
      const reached = sandboxMounts(layout({ cwd: forged })).filter((mount) => mount.dest.startsWith(foreign))
      expect(reached, forged).toEqual([])
      expect(canonicalRoot(forged), forged).not.toBe(foreign)
    }

    const submodule = make(repo, 'vendor', 'lib')
    const moduleGit = make(repo, '.git', 'modules', 'lib')
    touch(path.join(submodule, '.git'), 'gitdir: ../../.git/modules/lib\n')
    expect(canonicalRoot(submodule)).toBe(submodule)
    expect(canonicalRoot(worktree)).toBe(mainRepo)
    fs.rmSync(submodule, { recursive: true })
    fs.rmSync(moduleGit, { recursive: true })
  })

  it('masks hidden paths inside mounted directories, after the directories', () => {
    const secret = path.join(repo, '.env.secret')
    expect(find(mounts, secret)).toEqual([{ kind: 'mask', dest: secret }])
    expect(mounts.findIndex((mount) => mount.dest === secret)).toBeGreaterThan(
      mounts.findIndex((mount) => mount.dest === repo),
    )
  })

  it("masks Seti's and Claude Code's homes when a task directory holds them", () => {
    const outer = sandboxMounts(layout({ home: path.join(root, 'elsewhere'), cwd: home }))
    expect(find(outer, setiHome)).toEqual([{ kind: 'tmpfs', dest: setiHome }])
    expect(find(outer, claudeHome)).toEqual([{ kind: 'tmpfs', dest: claudeHome }])
    expect(find(outer, path.join(home, '.ssh'))).toEqual([{ kind: 'tmpfs', dest: path.join(home, '.ssh') }])
  })

  it('ends with the proxy socket directory and the CA bundle, read-only', () => {
    expect(mounts.slice(-3)).toEqual([
      { kind: 'ro-bind', src: caDir, dest: SANDBOX_CA },
      { kind: 'ro-bind', src: path.join(taskDir, 'run'), dest: SANDBOX_RUN },
      { kind: 'ro-bind', src: path.join(caDir, 'bundle.pem'), dest: '/etc/ssl/certs/ca-certificates.crt' },
    ])
  })

  it('applies parents before the directories inside them', () => {
    const order = dests(mounts)
    for (const [index, dest] of order.entries()) {
      const parent = order.findIndex((other) => dest.startsWith(`${other}/`))
      if (parent !== -1 && find(mounts, dest)[0]?.kind !== 'symlink') {
        expect(parent).toBeLessThan(index)
      }
    }
  })
})

describe('the home directory of an older agent with home access', () => {
  const mounts = sandboxMounts(layout())
  const code = path.join(home, 'code')

  it("binds the top-level code folders writable and the shared work folder, never the host's home", () => {
    expect(find(mounts, code)).toEqual([{ kind: 'bind', src: code, dest: code }])
    expect(find(mounts, branchCheckout)).toEqual([{ kind: 'bind', src: branchCheckout, dest: branchCheckout }])
    const work = path.join(home, WORK_DIR)
    expect(fs.existsSync(work)).toBe(true)
    expect(find(mounts, work)).toEqual([{ kind: 'bind', src: work, dest: work }])
    expect(find(mounts, home)).toEqual([{ kind: 'bind', src: path.join(taskDir, 'home'), dest: home }])
    expect(mounts.some((mount) => 'src' in mount && mount.src === home)).toBe(false)
  })

  it('mounts the Claude Code binary even inside an excluded folder, never inside a secret', () => {
    const binary = path.join(liveCheckout, 'node_modules', 'claude')
    touch(binary)
    const secretTool = path.join(home, '.ssh', 'tool')
    make(home, '.ssh')
    touch(secretTool)
    const pinned = sandboxMounts(layout({ readOnly: [binary, secretTool], excluded: [liveCheckout] }))
    expect(find(pinned, binary)).toEqual([{ kind: 'ro-bind', src: binary, dest: binary }])
    expect(find(pinned, secretTool)).toEqual([])
    expect(find(pinned, liveCheckout).filter((mount) => mount.kind !== 'tmpfs')).toEqual([])
  })

  it("mounts a shared tool's plugin folder read-only though it lies in Seti's own data", () => {
    const tool = make(setiHome, 'shared-tools', 'invoices-0123456789ab')
    const pinned = sandboxMounts(layout({ readOnly: [tool] }))
    expect(find(pinned, tool)).toEqual([{ kind: 'ro-bind', src: tool, dest: tool }])
    expect(dests(pinned, 'bind')).not.toContain(path.join(setiHome, 'shared-tools'))
    expect(dests(pinned)).not.toContain(setiHome)
  })

  it('skips top-level files, dot folders and excluded folders', () => {
    const all = dests(mounts)
    for (const skipped of [path.join(home, 'backup.key'), path.join(home, '.zshrc'), liveCheckout]) {
      expect(all).not.toContain(skipped)
    }
    expect(all).not.toContain(path.join(home, '.ssh'))
    expect(all).not.toContain(setiHome)
  })

  it('guards the git config and hooks of every bound repo, and a worktree pointer', () => {
    expect(dests(mounts, 'ro-bind')).toEqual(
      expect.arrayContaining([
        path.join(commonGit, 'config'),
        path.join(commonGit, 'hooks'),
        path.join(branchCheckout, '.git'),
      ]),
    )
    expect(dests(mounts, 'bind')).not.toContain(path.join(commonGit, 'worktrees'))
  })

  it("keeps other tasks' worktree records read-only, and its own and visible ones writable", () => {
    const readOnly = dests(mounts, 'ro-bind')
    expect(readOnly).toContain(otherAdmin)
    expect(readOnly).toContain(worktreeGit)
    expect(readOnly).not.toContain(branchAdmin)
    const own = dests(sandboxMounts(layout({ cwd: worktree })), 'ro-bind')
    expect(own).not.toContain(worktreeGit)
    expect(own).toContain(otherAdmin)
  })

  it('leaves the record of a worktree in its own private home writable, never one it cannot see', () => {
    const record = (name: string, dir: string) => {
      const admin = make(commonGit, 'worktrees', name)
      touch(path.join(admin, 'gitdir'), `${path.join(dir, '.git')}\n`)
      return admin
    }
    const own = record('own-home', path.join(home, 'own-home'))
    touch(path.join(taskDir, 'home', 'own-home', '.git'), `gitdir: ${own}\n`)
    const nested = record('own-nested', path.join(home, 'side', 'nested'))
    touch(path.join(taskDir, 'home', 'side', 'nested', '.git'), `gitdir: ${nested}\n`)
    const others = record('other-home', path.join(home, 'other-home'))
    touch(path.join(setiHome, 'sandbox', 'task-2', 'home', 'other-home', '.git'), `gitdir: ${others}\n`)
    const missing = record('gone', path.join(home, 'gone'))
    const emptied = record('emptied', path.join(home, 'emptied'))
    make(taskDir, 'home', 'emptied')
    const outside = record('outside', path.join(root, 'elsewhere'))
    touch(path.join(taskDir, 'home', '.seti', 'worktrees', 'task-2', '.git'), `gitdir: ${otherAdmin}\n`)

    const readOnly = dests(sandboxMounts(layout()), 'ro-bind')
    expect(readOnly).not.toContain(own)
    expect(readOnly).not.toContain(nested)
    expect(readOnly).not.toContain(branchAdmin)
    expect(readOnly).toEqual(expect.arrayContaining([others, missing, emptied, outside, otherAdmin]))

    const second = make(setiHome, 'sandbox', 'task-2')
    const fromOther = dests(sandboxMounts(layout({ taskDir: second })), 'ro-bind')
    expect(fromOther).not.toContain(others)
    expect(fromOther).toEqual(expect.arrayContaining([own, nested, missing]))
  })

  it("binds the main checkout's memory for a worktree task, not its other sessions", () => {
    const wt = sandboxMounts(layout({ cwd: worktree }))
    const memory = path.join('projects', projectSlug(mainRepo), 'memory')
    const inside = path.join(home, '.claude')
    expect(find(wt, path.join(inside, memory))).toEqual([
      { kind: 'bind', src: path.join(claudeHome, memory), dest: path.join(inside, memory) },
    ])
    expect(fs.existsSync(path.join(claudeHome, memory))).toBe(true)
    expect(dests(wt)).not.toContain(path.join(inside, 'projects', projectSlug(mainRepo)))
    expect(dests(mounts).filter((dest) => dest.endsWith('/memory'))).toEqual([])
  })
})

describe('a private sandbox, as every new agent gets', () => {
  const work = make(home, WORK_DIR)
  const own = make(work, 'fix-login-11111111')
  const neighbour = make(work, 'other-agent-22222222')
  const clone = make(own, 'app')
  make(clone, '.git', 'hooks')
  touch(path.join(clone, '.git', 'config'))
  const mounts = sandboxMounts(layout({ cwd: own, homeAccess: false }))
  const sources = mounts.flatMap((mount) => ('src' in mount ? [mount.src] : []))
  const outsideDotFolders = (dir: string) => !path.relative(home, dir).startsWith('.')

  it('binds its own folder writable and nothing else of the home folders, not even read-only', () => {
    expect(find(mounts, own)).toEqual([{ kind: 'bind', src: own, dest: own }])
    expect(find(mounts, home)).toEqual([{ kind: 'bind', src: path.join(taskDir, 'home'), dest: home }])
    const fromHome = sources.filter((src) => src.startsWith(`${home}/`) && outsideDotFolders(src))
    expect(fromHome).toEqual([own])
    for (const hidden of [path.join(home, 'code'), repo, mainRepo, branchCheckout, work, neighbour]) {
      expect(dests(mounts)).not.toContain(hidden)
    }
  })

  it('leaves the home folders out when home access is left unsaid', () => {
    const unsaid = Object.fromEntries(Object.entries(layout({ cwd: own })).filter(([key]) => key !== 'homeAccess'))
    expect(sandboxMounts(unsaid as unknown as SandboxLayout)).toEqual(mounts)
  })

  it('keeps the toolchains read-only and the package caches writable', () => {
    expect(dests(mounts, 'ro-bind')).toEqual(
      expect.arrayContaining([
        path.join(home, '.nvm'),
        path.join(home, '.gitconfig'),
        path.join(home, '.cargo', 'bin'),
      ]),
    )
    expect(dests(mounts, 'bind')).toContain(path.join(home, '.npm'))
    expect(dests(mounts)).not.toContain(path.join(home, '.ssh'))
  })

  it('works in a clone inside its folder with the folder still bound, and leaves the clone git config its own', () => {
    const moved = sandboxMounts(layout({ cwd: clone, dirs: [own], homeAccess: false, ownRoot: work }))
    expect(dests(moved, 'bind')).toEqual(expect.arrayContaining([own, clone]))
    expect(dests(moved, 'ro-bind').filter((dest) => dest.startsWith(own))).toEqual([])
    expect(dests(moved)).not.toContain(neighbour)
  })

  it('still covers the git config and hooks of a checkout of the user that an older agent runs in', () => {
    const inCheckout = sandboxMounts(layout({ homeAccess: false, ownRoot: work }))
    expect(dests(inCheckout, 'ro-bind')).toEqual(
      expect.arrayContaining([path.join(repo, '.git', 'config'), path.join(repo, '.git', 'hooks')]),
    )
    const inWorktree = sandboxMounts(layout({ cwd: worktree, homeAccess: false, ownRoot: work }))
    expect(dests(inWorktree, 'bind')).toContain(commonGit)
    expect(dests(inWorktree, 'ro-bind')).toEqual(
      expect.arrayContaining([
        path.join(commonGit, 'config'),
        path.join(commonGit, 'hooks'),
        path.join(worktree, '.git'),
      ]),
    )
  })

  it('does not follow a .git file the agent wrote to a repository outside its folders', () => {
    const forged = make(own, 'forged')
    const admin = make(own, 'forged-admin')
    touch(path.join(forged, '.git'), `gitdir: ${admin}\n`)
    touch(path.join(admin, 'commondir'), `${commonGit}\n`)
    const forgedMounts = sandboxMounts(layout({ cwd: forged, dirs: [own], homeAccess: false, ownRoot: work }))
    const reached = forgedMounts.filter(
      (mount) => mount.dest.startsWith(mainRepo) || ('src' in mount && mount.src.startsWith(mainRepo)),
    )
    expect(reached).toEqual([])
    expect(dests(forgedMounts).some((dest) => dest.includes(projectSlug(mainRepo)))).toBe(false)
    const older = sandboxMounts(layout({ cwd: forged, dirs: [own] }))
    expect(dests(older, 'bind')).toContain(commonGit)
  })

  it('takes the home folders away from an older agent once its home access is switched off', () => {
    const before = sandboxMounts(layout({ cwd: worktree }))
    const after = sandboxMounts(layout({ cwd: worktree, homeAccess: false }))
    const lost = dests(before).filter((dest) => !dests(after).includes(dest))
    expect(lost).toEqual(expect.arrayContaining([path.join(home, 'code'), branchCheckout, work]))
    expect(dests(after, 'bind')).toEqual(expect.arrayContaining([worktree, commonGit]))
    expect(dests(after)).not.toContain(path.join(home, 'code'))
  })
})

describe('mountProblem', () => {
  it('refuses the home directory, its parents, Seti data and credentials', () => {
    expect(mountProblem(home, layout())).toMatch(/holds your home directory/)
    expect(mountProblem('/', layout())).toMatch(/holds your home directory/)
    expect(mountProblem(path.join(setiHome, 'backups'), layout())).toMatch(/Seti's own data/)
    expect(mountProblem(path.join(setiHome, 'worktrees'), layout())).toMatch(/Seti's own data/)
    expect(mountProblem(path.join(claudeHome, 'projects'), layout())).toMatch(/credentials/)
    expect(mountProblem(path.join(home, '.ssh', 'keys'), layout())).toMatch(/credentials/)
    expect(mountProblem('relative', layout())).toMatch(/absolute/)
  })

  it('accepts project folders and task worktrees', () => {
    expect(mountProblem(repo, layout())).toBeNull()
    expect(mountProblem(worktree, layout())).toBeNull()
    expect(mountProblem('/srv/data', layout())).toBeNull()
  })
})

describe('bwrapArgs', () => {
  it('unshares every namespace but the mount one it builds, and dies with Seti', () => {
    const args = bwrapArgs([{ kind: 'mask', dest: '/work/.env' }], '/work')
    expect(args).toEqual(
      expect.arrayContaining([
        '--unshare-user',
        '--unshare-pid',
        '--unshare-net',
        '--unshare-ipc',
        '--unshare-uts',
        '--die-with-parent',
        '--new-session',
      ]),
    )
    expect(args.join(' ')).toContain('--proc /proc --dev /dev --ro-bind /dev/null /work/.env --chdir /work')
  })

  it('keeps the controlling terminal only for an interactive command', () => {
    const args = bwrapArgs([], '/work', true)
    expect(args).not.toContain('--new-session')
    expect(args).toEqual(expect.arrayContaining(['--unshare-pid', '--unshare-net', '--die-with-parent']))
  })
})

describe('projectSlug', () => {
  it('matches the folder names Claude Code uses, hashing long paths', () => {
    expect(projectSlug('/home/me/code/my_app')).toBe('-home-me-code-my-app')
    const long = `/${'a'.repeat(250)}`
    expect(projectSlug(long)).toMatch(/^-a{199}-[0-9a-z]+$/)
  })
})

describe('sandboxClaudeJson', () => {
  const host = touch(
    path.join(root, 'host.json'),
    JSON.stringify({
      hasCompletedOnboarding: true,
      userID: 'user-1',
      oauthAccount: { emailAddress: 'me@example.com' },
      primaryApiKey: 'sk-ant-api-fake',
      customApiKeyResponses: { approved: ['x'] },
      projects: {
        '/elsewhere': { history: ['secret prompt'] },
        '/work/app': {
          history: ['another secret prompt'],
          mcpServers: {
            local: { type: 'http', url: 'https://local.example.com/mcp' },
            'local-keyed': { type: 'http', url: 'https://local.example.com/mcp', headers: { 'x-key': 'k' } },
          },
        },
      },
      mcpServers: {
        plain: { type: 'stdio', command: 'my-mcp' },
        keyed: { type: 'stdio', command: 'x', env: { API_KEY: 'k' } },
        headed: { type: 'http', url: 'https://mcp.example.com', headers: { Authorization: 'Bearer k' } },
        queried: { type: 'http', url: 'https://mcp.example.com/?key=k' },
        remote: { type: 'http', url: 'https://mcp.example.com/mcp' },
        tracker: { type: 'sse', url: 'https://tracker.example.com/sse', headers: { 'x-team': 't' } },
      },
    }),
  )

  it('copies onboarding state, the profile and secret-free MCP servers, nothing else', () => {
    const copy = path.join(root, 'copy.json')
    touch(copy, JSON.stringify({ numStartups: 3, primaryApiKey: 'left-over' }))
    sandboxClaudeJson(host, copy)
    const written = JSON.parse(fs.readFileSync(copy, 'utf8')) as Record<string, unknown>
    expect(written).toEqual({
      numStartups: 3,
      hasCompletedOnboarding: true,
      userID: 'user-1',
      oauthAccount: { emailAddress: 'me@example.com' },
      mcpServers: {
        plain: { type: 'stdio', command: 'my-mcp' },
        remote: { type: 'http', url: 'https://mcp.example.com/mcp' },
      },
    })
    expect(fs.statSync(copy).mode & 0o777).toBe(0o600)
  })

  it('adds servers the host signed in to as transport and URL, and the local servers of the task', () => {
    const copy = path.join(root, 'signed-in.json')
    sandboxClaudeJson(host, copy, { signedIn: new Set(['tracker', 'headed', 'local-keyed']), projects: ['/work/app'] })
    const written = JSON.parse(fs.readFileSync(copy, 'utf8')) as Record<string, unknown>
    expect(written.mcpServers).toEqual({
      plain: { type: 'stdio', command: 'my-mcp' },
      headed: { type: 'http', url: 'https://mcp.example.com' },
      remote: { type: 'http', url: 'https://mcp.example.com/mcp' },
      tracker: { type: 'sse', url: 'https://tracker.example.com/sse' },
    })
    expect(written.projects).toEqual({
      '/work/app': {
        mcpServers: {
          local: { type: 'http', url: 'https://local.example.com/mcp' },
          'local-keyed': { type: 'http', url: 'https://local.example.com/mcp' },
        },
      },
    })
    expect(JSON.stringify(written)).not.toMatch(/secret prompt|Bearer k|x-key|x-team/)
  })

  it("adds a keyed server without its keys when the task's profile has a header rule for its host", () => {
    const copy = path.join(root, 'covered.json')
    sandboxClaudeJson(host, copy, {
      signedIn: new Set(),
      projects: ['/work/app'],
      covered: (name) => name === 'tracker.example.com' || name === 'local.example.com',
    })
    const written = JSON.parse(fs.readFileSync(copy, 'utf8')) as Record<string, unknown>
    expect(written.mcpServers).toMatchObject({ tracker: { type: 'sse', url: 'https://tracker.example.com/sse' } })
    expect(written.mcpServers).not.toHaveProperty('headed')
    expect(JSON.stringify(written)).not.toMatch(/x-team|x-key|Bearer k/)
  })

  it('leaves out the servers the task turned off, user and project ones alike', () => {
    const copy = path.join(root, 'denied.json')
    sandboxClaudeJson(host, copy, {
      signedIn: new Set(['tracker']),
      projects: ['/work/app'],
      denied: new Set(['tracker', 'plain', 'local']),
    })
    const written = JSON.parse(fs.readFileSync(copy, 'utf8')) as {
      mcpServers: Record<string, unknown>
      projects?: Record<string, { mcpServers: Record<string, unknown> }>
    }
    expect(Object.keys(written.mcpServers)).toEqual(['remote'])
    expect(Object.keys(written.projects?.['/work/app']?.mcpServers ?? {})).toEqual([])
  })

  it('adds borrowed servers as user servers, under the same rules for keys and choices', () => {
    const copy = path.join(root, 'borrowed.json')
    sandboxClaudeJson(host, copy, {
      signedIn: new Set(['oauth']),
      projects: ['/work/app'],
      denied: new Set(['off']),
      borrowed: {
        staging: { type: 'http', url: 'https://staging.example.com/mcp' },
        oauth: { type: 'http', url: 'https://oauth.example.com/mcp', headers: { 'x-key': 'k' } },
        'borrowed-keyed': {
          type: 'http',
          url: 'https://keyed.example.com/mcp',
          headers: { Authorization: 'Bearer k' },
        },
        off: { type: 'http', url: 'https://off.example.com/mcp' },
      },
    })
    const written = JSON.parse(fs.readFileSync(copy, 'utf8')) as { mcpServers: Record<string, unknown> }
    expect(written.mcpServers).toMatchObject({
      staging: { type: 'http', url: 'https://staging.example.com/mcp' },
      oauth: { type: 'http', url: 'https://oauth.example.com/mcp' },
    })
    expect(Object.keys(written.mcpServers)).not.toContain('off')
    expect(Object.keys(written.mcpServers)).not.toContain('borrowed-keyed')
    expect(JSON.stringify(written)).not.toMatch(/Bearer k|x-key/)
  })

  it('starts from nothing when the host has no config', () => {
    const copy = path.join(root, 'fresh.json')
    sandboxClaudeJson(path.join(root, 'missing.json'), copy)
    expect(JSON.parse(fs.readFileSync(copy, 'utf8'))).toEqual({ hasCompletedOnboarding: true, mcpServers: {} })
    expect(sandboxServers('nope', new Set())).toEqual({})
  })
})

describe("a Codex agent's mounts", () => {
  it("leave out Claude Code's configuration and lock Codex's settings, variables and command rules", () => {
    const mounts = sandboxMounts(layout({ codex: true }))
    expect(dests(mounts).filter((dest) => dest.startsWith(path.join(home, '.claude')))).toEqual([])
    const codex = path.join(home, '.codex')
    const blank = path.join(taskDir, 'empty-file')
    for (const name of ['config.toml', '.env']) {
      expect(find(mounts, path.join(codex, name))).toEqual([
        { kind: 'ro-bind', src: blank, dest: path.join(codex, name) },
      ])
    }
    expect(find(mounts, path.join(codex, 'rules'))).toEqual([
      { kind: 'ro-bind', src: path.join(taskDir, 'empty'), dest: path.join(codex, 'rules') },
    ])
  })

  it("cover Codex's sign-in, environments, instructions, roles, skills and the shell's startup files", () => {
    const mounts = sandboxMounts(layout({ codex: true }))
    const codex = path.join(home, '.codex')
    const masked = ['auth.json', 'environments.toml', 'AGENTS.md', 'AGENTS.override.md'].map((name) =>
      path.join(codex, name),
    )
    const startup = ['.zshenv', '.zshenv.zwc', '.zprofile', '.zlogin', '.zshrc', '.bash_profile', '.profile', '.bashrc']
    for (const dest of [...masked, ...startup.map((name) => path.join(home, name))]) {
      expect(find(mounts, dest)).toEqual([{ kind: 'ro-bind', src: path.join(taskDir, 'empty-file'), dest }])
    }
    for (const dest of [path.join(codex, 'agents'), path.join(home, '.agents')]) {
      expect(find(mounts, dest)).toEqual([{ kind: 'ro-bind', src: path.join(taskDir, 'empty'), dest }])
    }
  })

  it("give Codex the user's own CLAUDE.md, read-only, as its global instructions", () => {
    const own = make(root, 'claude-home-with-instructions')
    touch(path.join(own, 'CLAUDE.md'), 'USER_INSTRUCTIONS')
    const dest = path.join(home, '.codex', 'AGENTS.md')
    expect(find(codexLocks(layout({ codex: true, claudeHome: own })), dest)).toEqual([
      { kind: 'ro-bind', src: path.join(own, 'CLAUDE.md'), dest },
    ])
    const override = path.join(home, '.codex', 'AGENTS.override.md')
    expect(find(codexLocks(layout({ codex: true, claudeHome: own })), override)).toEqual([
      { kind: 'ro-bind', src: path.join(taskDir, 'empty-file'), dest: override },
    ])
    const bare = layout({ codex: true, claudeHome: own, maintenance: { writable: [], bare: true } })
    expect(find(codexLocks(bare), dest)).toEqual([{ kind: 'ro-bind', src: path.join(taskDir, 'empty-file'), dest }])
  })

  it("cover the machine's own Codex settings only where the machine has them", () => {
    const hostConfig = make(root, 'etc-codex')
    const empty = path.join(taskDir, 'empty')
    expect(find(codexLocks(layout({ codex: true }), hostConfig), hostConfig)).toEqual([
      { kind: 'ro-bind', src: empty, dest: hostConfig },
    ])
    expect(find(codexLocks(layout({ codex: true }), path.join(root, 'none')), path.join(root, 'none'))).toEqual([])
  })
})
