import path from 'node:path'
import { resolvePath } from './paths.js'

/** Directories of repository state or configuration that runs code, as Claude Code lists them. */
const PROTECTED_DIRS = new Set([
  '.git',
  '.vscode',
  '.idea',
  '.husky',
  '.cargo',
  '.devcontainer',
  '.yarn',
  '.mvn',
  '.claude',
])

/** Places under `.claude` Claude Code itself writes, which stay writable. */
const CLAUDE_OWN = [
  /\/\.claude\/worktrees(\/|$)/,
  /\/\.claude\/plans\//,
  /\/\.claude\/jobs\/[^/]+\/tmp\//,
  /\/\.claude\/(agent-memory|projects\/[^/]+\/memory)\/.*\.md$/,
]

const PROTECTED_FILES = new Set([
  '.gitconfig',
  '.gitmodules',
  '.bashrc',
  '.bash_profile',
  '.bash_login',
  '.bash_aliases',
  '.bash_logout',
  '.zshrc',
  '.zprofile',
  '.zshenv',
  '.zlogin',
  '.zlogout',
  '.profile',
  '.envrc',
  '.npmrc',
  '.yarnrc',
  '.yarnrc.yml',
  '.pnp.cjs',
  '.pnp.loader.mjs',
  '.pnpmfile.cjs',
  'bunfig.toml',
  '.bunfig.toml',
  '.bazelrc',
  '.bazelversion',
  '.bazeliskrc',
  '.pre-commit-config.yaml',
  'lefthook.yml',
  'lefthook.yaml',
  '.lefthook.yml',
  '.lefthook.yaml',
  'gradle-wrapper.properties',
  'maven-wrapper.properties',
  '.devcontainer.json',
  '.ripgreprc',
  'pyrightconfig.json',
  '.mcp.json',
  '.claude.json',
])

/** Whether writing the absolute path touches repository state or configuration that runs code. */
export function isProtected(target: string): boolean {
  const parts = target.split('/')
  const dirs = parts.slice(0, -1)
  const inDir = dirs.some(
    (part, i) =>
      (PROTECTED_DIRS.has(part) && !(part === '.claude' && CLAUDE_OWN.some((own) => own.test(target)))) ||
      (part === '.config' && dirs[i + 1] === 'git'),
  )
  const isDir = PROTECTED_DIRS.has(parts[parts.length - 1] ?? '')
  return inDir || isDir || PROTECTED_FILES.has(path.basename(target))
}

const TOP_NAMES = /^(mnt|tmp|usr|Users|home|etc|var|opt|bin|lib|lib64|root|srv|boot|dev|proc|sys|data)(\/|$)/

interface Where {
  cwd: string
  home: string
  dirs: readonly string[]
}

function criticalPath(target: string, where: Where, glob: boolean): boolean {
  const resolved = resolvePath(target === '' ? '.' : target, where.cwd, where.home)
  const parentOf = (dir: string) => dir === resolved || dir.startsWith(`${resolved === '/' ? '' : resolved}/`)
  return (
    resolved === '/' ||
    path.dirname(resolved) === '/' ||
    resolved === where.home ||
    parentOf(where.cwd) ||
    (glob && where.dirs.some(parentOf))
  )
}

function computedCritical(target: string, recursive: boolean, where: Where): boolean {
  const at = target.search(/[$`]/)
  const before = target.slice(0, at)
  if (before !== '') {
    return criticalPath(before, where, false)
  }
  const rest = target.slice(at)
  const variable = /^\$(\{\w+\}|\w+|[@*#]|\d)/.exec(rest)?.[0] ?? ''
  const after = rest.slice(variable.length)
  if (variable === '') {
    return recursive
  }
  return /^\/\*?\/?$/.test(after) || after.startsWith('/*') || TOP_NAMES.test(after.replace(/^\//, ''))
}

/** Whether an `rm` or `rmdir` target is one Claude Code never lets a rule approve. */
function criticalTarget(target: string, recursive: boolean, where: Where): boolean {
  if (/^\\+$/.test(target)) {
    return true
  }
  if (/[$`]/.test(target)) {
    return computedCritical(target, recursive, where)
  }
  if (/\*\/\*?$/.test(target) || target.endsWith('*/')) {
    return true
  }
  const glob = target.search(/[*?[]/)
  return glob === -1
    ? criticalPath(target, where, false)
    : criticalPath(target.slice(0, glob).replace(/\/$/, ''), where, true)
}

const isRecursive = (flag: string) => flag === '--recursive' || /^-[A-Za-z]*[rR]/.test(flag)

/** Whether a command removes the root, a top-level directory, home, the cwd or one of its parents. */
export function criticalRemoval(words: readonly string[], where: Where): boolean {
  const [program, ...args] = words
  if (program !== 'rm' && program !== 'rmdir') {
    return false
  }
  const ends = args.indexOf('--')
  const flags = (ends === -1 ? args : args.slice(0, ends)).filter((arg) => arg.startsWith('-'))
  const targets =
    ends === -1
      ? args.filter((arg) => !arg.startsWith('-'))
      : [...args.slice(0, ends).filter((arg) => !arg.startsWith('-')), ...args.slice(ends + 1)]
  const recursive = program === 'rmdir' || flags.some(isRecursive)
  return targets.some((target) => criticalTarget(target, recursive, where))
}
