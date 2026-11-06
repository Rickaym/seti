import fs from 'node:fs'
import path from 'node:path'

export type Mount =
  | { kind: 'bind' | 'ro-bind'; src: string; dest: string }
  | { kind: 'tmpfs' | 'mask'; dest: string }
  | { kind: 'symlink'; target: string; dest: string }

/** Where a sandbox finds the proxy socket and the CA files, inside its own /run. */
export const SANDBOX_RUN = '/run/seti'
export const SANDBOX_CA = '/run/seti-ca'
export const SANDBOX_SSH_AGENT = '/run/seti-ssh'

/** What a task's sandbox is built from; every path is absolute and as the host sees it. */
export interface SandboxLayout {
  home: string
  setiHome: string
  worktreeRoot: string
  claudeHome: string
  /** The task's own state: its home, /tmp, plugin data and proxy socket directory. */
  taskDir: string
  cwd: string
  /** Further directories the task works in, read-write like cwd. */
  dirs: readonly string[]
  /** The task's Seti workspace, read-write although it lives in Seti's own data. */
  workspace?: string | null
  /** Read-only extras such as the Claude Code binary and local plugin folders. */
  readOnly: readonly string[]
  caDir: string
  systemBundle: string | null
  /** Credentials and user-hidden paths, masked wherever a mounted directory contains them. */
  hidden: readonly string[]
  /** Home folders kept out of the code share but not secret; pinned read-only extras may sit inside. */
  excluded?: readonly string[]
  pathEnv: string
  sessionId: string | null
  /** The task's generated ~/.ssh and the agent socket's directory, when it has ssh hosts. */
  ssh?: { dir: string; agentDir: string } | null
}

const SYSTEM_DIRS = ['/usr', '/etc']
const ROOT_LINKS = ['/bin', '/sbin', '/lib', '/lib32', '/lib64', '/libx32']

/** Toolchains under the home directory that agents run, mounted read-only. */
const TOOLCHAINS = ['.nvm', '.rustup', '.local/share/uv', '.bun/bin', '.deno/bin', '.gitconfig', '.config/git']

/** Package manager and browser caches that installs and test runs write to. */
const CACHES = [
  '.cache/uv',
  '.cache/pip',
  '.cache/pnpm',
  '.local/share/pnpm/store',
  '.local/state/pnpm',
  '.npm',
  '.cache/node/corepack',
  '.cache/node-gyp',
  '.cache/ms-playwright',
  '.cache/typescript',
  '.cargo/registry',
  '.cargo/git',
  '.bun/install/cache',
]

/** Claude Code configuration the sandbox reads; sessions and credentials are not among it. */
const CLAUDE_CONFIG = [
  'settings.json',
  'CLAUDE.md',
  'skills',
  'agents',
  'commands',
  'plugins',
  'output-styles',
  'hooks',
  'keybindings.json',
]

const exists = (file: string) => fs.existsSync(file)

const within = (child: string, parent: string) =>
  child === parent || child.startsWith(parent.endsWith('/') ? parent : `${parent}/`)

/** The project folder name Claude Code files a directory's sessions under. */
export function projectSlug(dir: string): string {
  const slug = dir.replace(/[^a-zA-Z0-9]/g, '-')
  if (slug.length <= 200) {
    return slug
  }
  let hash = 0
  for (let i = 0; i < dir.length; i++) {
    hash = (Math.imul(hash, 31) + dir.charCodeAt(i)) | 0
  }
  return `${slug.slice(0, 200)}-${Math.abs(hash).toString(36)}`
}

/** What decides whether a directory can be mounted read-write into a sandbox. */
export type MountRules = Pick<SandboxLayout, 'home' | 'setiHome' | 'worktreeRoot' | 'claudeHome' | 'hidden'>

/** Why a directory cannot be mounted into a sandbox, or null when it can. */
export function mountProblem(dir: string, layout: MountRules): string | null {
  if (!path.isAbsolute(dir)) {
    return `${dir} is not an absolute path`
  }
  if (within(layout.home, dir)) {
    return `${dir} holds your home directory`
  }
  if (within(dir, layout.setiHome) && !(within(dir, layout.worktreeRoot) && dir !== layout.worktreeRoot)) {
    return `${dir} is part of Seti's own data`
  }
  if (within(dir, layout.claudeHome) || layout.hidden.some((secret) => within(dir, secret))) {
    return `${dir} holds credentials`
  }
  return null
}

interface GitDirs {
  common: string
  own: string
  linked: boolean
}

function gitDirs(dir: string): GitDirs | null {
  const dotGit = path.join(dir, '.git')
  const stat = fs.statSync(dotGit, { throwIfNoEntry: false })
  if (stat?.isDirectory() === true) {
    return { common: dotGit, own: dotGit, linked: false }
  }
  if (stat?.isFile() !== true) {
    return null
  }
  const text = fs.readFileSync(dotGit, 'utf8').trim()
  const pointer = text.startsWith('gitdir:') ? text.slice('gitdir:'.length).trim() : ''
  if (pointer === '') {
    return null
  }
  const own = path.resolve(dir, pointer)
  const commonFile = path.join(own, 'commondir')
  const common = exists(commonFile) ? path.resolve(own, fs.readFileSync(commonFile, 'utf8').trim()) : own
  return { common, own, linked: true }
}

interface GitMounts {
  writable: string[]
  guards: string[]
  common: string | null
}

/** The shared .git a worktree writes commits into, and read-only covers for what runs code. */
function gitMounts(dir: string): GitMounts {
  const git = gitDirs(dir)
  if (git === null) {
    return { writable: [], guards: [], common: null }
  }
  fs.mkdirSync(path.join(git.common, 'hooks'), { recursive: true })
  const guards = [path.join(git.common, 'config'), path.join(git.common, 'hooks')]
  if (git.linked) {
    guards.push(path.join(dir, '.git'), path.join(git.own, 'config.worktree'))
  }
  return { writable: git.linked ? [git.common] : [], guards: guards.filter(exists), common: git.common }
}

/**
 * Admin folders of worktrees the sandbox cannot see, such as other tasks' worktrees; they stay
 * read-only so that `git worktree prune` inside cannot drop them for looking deleted.
 */
function unseenWorktrees(commons: readonly string[], visible: readonly string[]): string[] {
  return commons.flatMap((common) => {
    const admin = path.join(common, 'worktrees')
    const names = fs.statSync(admin, { throwIfNoEntry: false })?.isDirectory() === true ? fs.readdirSync(admin) : []
    return names
      .map((name) => path.join(admin, name))
      .filter((entry) => {
        const pointer = path.join(entry, 'gitdir')
        if (!exists(pointer)) {
          return false
        }
        const worktree = path.dirname(path.resolve(entry, fs.readFileSync(pointer, 'utf8').trim()))
        return !visible.some((root) => within(worktree, root))
      })
  })
}

/** The repository Claude Code files a directory's memory under: a worktree's main checkout. */
export function canonicalRoot(dir: string): string | null {
  for (let current = dir; ; current = path.dirname(current)) {
    const git = gitDirs(current)
    if (git !== null) {
      return git.linked && path.basename(git.common) === '.git' ? path.dirname(git.common) : current
    }
    if (path.dirname(current) === current) {
      return null
    }
  }
}

function systemMounts(): Mount[] {
  const mounts: Mount[] = SYSTEM_DIRS.map((dir) => ({ kind: 'ro-bind', src: dir, dest: dir }))
  for (const link of ROOT_LINKS) {
    const stat = fs.lstatSync(link, { throwIfNoEntry: false })
    if (stat?.isSymbolicLink() === true) {
      mounts.push({ kind: 'symlink', target: fs.readlinkSync(link), dest: link })
    } else if (stat?.isDirectory() === true) {
      mounts.push({ kind: 'ro-bind', src: link, dest: link })
    }
  }
  return [
    ...mounts,
    { kind: 'tmpfs', dest: '/run' },
    { kind: 'tmpfs', dest: '/var' },
    { kind: 'symlink', target: '../run', dest: '/var/run' },
    { kind: 'symlink', target: '../tmp', dest: '/var/tmp' },
  ]
}

const isSystem = (dir: string) => [...SYSTEM_DIRS, ...ROOT_LINKS, '/snap'].some((root) => within(dir, root))

/** Directories on PATH outside the system ones, such as ~/.local/bin, mounted read-only. */
function pathDirs(layout: SandboxLayout): string[] {
  return layout.pathEnv
    .split(':')
    .filter((dir) => path.isAbsolute(dir) && !isSystem(dir) && exists(dir))
    .filter((dir) => !within(dir, layout.setiHome) && !within(dir, layout.claudeHome))
}

/** The one top-level home folder every sandbox shares for new checkouts. */
export const WORK_DIR = 'work'

/**
 * The home directory's top-level folders without a dot, where the user keeps code checkouts, and
 * the shared work folder. Files and dot folders at the top level are never among them.
 */
function homeDirs(layout: SandboxLayout): string[] {
  fs.mkdirSync(path.join(layout.home, WORK_DIR), { recursive: true })
  return fs
    .readdirSync(layout.home, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => path.join(layout.home, entry.name))
    .filter((dir) => !layout.hidden.some((secret) => within(dir, secret)))
    .filter((dir) => !within(layout.setiHome, dir) && !within(layout.claudeHome, dir))
}

interface HostBinds {
  writable: string[]
  readOnly: string[]
  guards: string[]
}

/** Binds from the host at the same path, with writable ones listed separately. */
function hostBinds(layout: SandboxLayout): HostBinds {
  const shown = (dir: string) => exists(dir) && !layout.hidden.some((secret) => within(dir, secret))
  const workDirs = [layout.cwd, ...layout.dirs]
  const code = homeDirs(layout)
  const git = [...workDirs, ...code].map(gitMounts)
  const commons = git.flatMap((entry) => entry.writable).filter((dir) => mountProblem(dir, layout) === null)
  const writable = [...workDirs, ...code, ...commons, ...CACHES.map((dir) => path.join(layout.home, dir)).filter(shown)]
  const secrets = layout.hidden.filter((entry) => !(layout.excluded ?? []).includes(entry))
  const pinned = layout.readOnly.filter((file) => exists(file) && !secrets.some((secret) => within(file, secret)))
  const readOnly = [
    ...[
      ...TOOLCHAINS.map((entry) => path.join(layout.home, entry)),
      ...pathDirs(layout),
      path.dirname(path.dirname(process.execPath)),
    ].filter(shown),
    ...pinned,
  ].filter((dir) => !isSystem(dir) && !writable.some((root) => within(dir, root)))
  const repos = [...new Set(git.flatMap((entry) => (entry.common === null ? [] : [entry.common])))]
  const guards = [...git.flatMap((entry) => entry.guards), ...unseenWorktrees(repos, writable)]
  return { writable, readOnly, guards: [...new Set(guards)] }
}

/**
 * The auto memory folders of the main checkouts behind the task's directories, which Claude Code
 * uses from worktrees too; the task's own project folder already holds its memory.
 */
function memoryDirs(layout: SandboxLayout): string[] {
  const own = projectSlug(layout.cwd)
  const slugs = [layout.cwd, ...layout.dirs]
    .map(canonicalRoot)
    .flatMap((root) => (root === null ? [] : [projectSlug(root)]))
    .filter((slug) => slug !== own)
  return [...new Set(slugs)].map((slug) => path.join('projects', slug, 'memory'))
}

/** Claude Code's configuration, this directory's sessions and the checkpoints of the session. */
function claudeMounts(layout: SandboxLayout): Mount[] {
  const inside = path.join(layout.home, '.claude')
  const mounts: Mount[] = CLAUDE_CONFIG.filter((entry) => exists(path.join(layout.claudeHome, entry))).map((entry) => ({
    kind: 'ro-bind',
    src: path.join(layout.claudeHome, entry),
    dest: path.join(inside, entry),
  }))
  if (exists(path.join(layout.claudeHome, 'plugins'))) {
    const data = path.join(layout.taskDir, 'plugin-data')
    fs.mkdirSync(data, { recursive: true })
    // bwrap cannot make the mount point inside the read-only plugins mount, so it must exist
    fs.mkdirSync(path.join(layout.claudeHome, 'plugins', 'data'), { recursive: true, mode: 0o700 })
    mounts.push({ kind: 'bind', src: data, dest: path.join(inside, 'plugins', 'data') })
  }
  const project = path.join('projects', projectSlug(layout.cwd))
  fs.mkdirSync(path.join(layout.claudeHome, project), { recursive: true, mode: 0o700 })
  mounts.push({ kind: 'bind', src: path.join(layout.claudeHome, project), dest: path.join(inside, project) })
  for (const memory of memoryDirs(layout)) {
    fs.mkdirSync(path.join(layout.claudeHome, memory), { recursive: true, mode: 0o700 })
    mounts.push({ kind: 'bind', src: path.join(layout.claudeHome, memory), dest: path.join(inside, memory) })
  }
  const history = layout.sessionId === null ? null : path.join('file-history', layout.sessionId)
  if (history !== null && exists(path.join(layout.claudeHome, history))) {
    mounts.push({ kind: 'bind', src: path.join(layout.claudeHome, history), dest: path.join(inside, history) })
  }
  return mounts
}

const byDest = (a: Mount, b: Mount) => a.dest.localeCompare(b.dest, 'en')

/** Hidden paths and Seti's and Claude Code's homes that a mounted directory would show, covered. */
function masks(layout: SandboxLayout, mounted: readonly string[]): Mount[] {
  return [...layout.hidden, layout.setiHome, layout.claudeHome]
    .filter((secret) => mounted.some((dir) => within(secret, dir) && secret !== dir))
    .flatMap((secret): Mount[] => {
      const stat = fs.statSync(secret, { throwIfNoEntry: false })
      if (stat === undefined) {
        return []
      }
      return [{ kind: stat.isDirectory() ? 'tmpfs' : 'mask', dest: secret }]
    })
}

/**
 * Every mount of a task's sandbox, in the order bwrap applies them: the system read-only, a
 * private home and /tmp, the task's directories and caches, then covers for what must not
 * change or show, and last the proxy socket and CA.
 */
export function sandboxMounts(layout: SandboxLayout): Mount[] {
  const binds = hostBinds(layout)
  const workspace = layout.workspace ?? null
  const user: Mount[] = [
    ...binds.writable.map((dir): Mount => ({ kind: 'bind', src: dir, dest: dir })),
    ...(workspace === null ? [] : [{ kind: 'bind', src: workspace, dest: workspace } satisfies Mount]),
    ...binds.readOnly.map((dir): Mount => ({ kind: 'ro-bind', src: dir, dest: dir })),
    ...claudeMounts(layout),
  ]
  const unique = [...new Map(user.map((mount) => [mount.dest, mount])).values()].sort(byDest)
  const ca: Mount[] = [
    { kind: 'ro-bind', src: layout.caDir, dest: SANDBOX_CA },
    { kind: 'ro-bind', src: path.join(layout.taskDir, 'run'), dest: SANDBOX_RUN },
  ]
  if (layout.systemBundle !== null) {
    ca.push({ kind: 'ro-bind', src: path.join(layout.caDir, 'bundle.pem'), dest: layout.systemBundle })
  }
  if (layout.ssh !== undefined && layout.ssh !== null) {
    ca.push(
      { kind: 'ro-bind', src: layout.ssh.dir, dest: path.join(layout.home, '.ssh') },
      { kind: 'ro-bind', src: layout.ssh.agentDir, dest: SANDBOX_SSH_AGENT },
    )
  }
  return [
    ...systemMounts(),
    { kind: 'bind', src: path.join(layout.taskDir, 'tmp'), dest: '/tmp' },
    { kind: 'bind', src: path.join(layout.taskDir, 'home'), dest: layout.home },
    ...unique,
    ...binds.guards.map((file): Mount => ({ kind: 'ro-bind', src: file, dest: file })),
    ...masks(layout, [...binds.writable, ...binds.readOnly]),
    ...ca,
  ]
}

function mountArgs(mount: Mount): string[] {
  switch (mount.kind) {
    case 'bind':
      return ['--bind', mount.src, mount.dest]
    case 'ro-bind':
      return ['--ro-bind', mount.src, mount.dest]
    case 'tmpfs':
      return ['--tmpfs', mount.dest]
    case 'mask':
      return ['--ro-bind', '/dev/null', mount.dest]
    case 'symlink':
      return ['--symlink', mount.target, mount.dest]
  }
}

/**
 * bwrap arguments: fresh pid, network, ipc and uts namespaces, then the mounts. An interactive
 * command keeps its terminal as the controlling one: it holds a pseudo-terminal of its own that
 * no process outside the sandbox reads, so the new session that guards a shared one is left out.
 */
export function bwrapArgs(mounts: readonly Mount[], cwd: string, interactive = false): string[] {
  return [
    '--unshare-user',
    '--unshare-pid',
    '--unshare-net',
    '--unshare-ipc',
    '--unshare-uts',
    '--hostname',
    'seti-sandbox',
    '--die-with-parent',
    ...(interactive ? [] : ['--new-session']),
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    ...mounts.flatMap(mountArgs),
    '--chdir',
    cwd,
  ]
}
