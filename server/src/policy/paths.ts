import path from 'node:path'
import type { RuleBehavior } from './types.js'

/** Where a rule's relative patterns start: its settings source, the cwd and the home directory. */
export interface PathScope {
  anchor: string
  cwd: string
  home: string
}

/** A call's path as an absolute one, with `~` as the home directory. */
export function resolvePath(given: string, cwd: string, home: string): string {
  const expanded = given === '~' || given.startsWith('~/') ? path.join(home, given.slice(1)) : given
  return path.resolve(cwd, expanded)
}

/** Whether the path is one of the directories or inside one. */
export const insideAny = (target: string, dirs: readonly string[]): boolean =>
  dirs.some((dir) => target === dir || target.startsWith(dir === '/' ? '/' : `${dir}/`))

const escape = (char: string) => char.replace(/[.+^${}()|\\]/g, '\\$&')

const GLOB_CHARS: Record<string, string> = { '*': '[^/]*', '?': '[^/]' }

function segment(glob: string): string {
  let out = ''
  let i = 0
  while (i < glob.length) {
    const char = glob[i] ?? ''
    const close = char === '[' ? glob.indexOf(']', i + 1) : -1
    if (close > i + 1) {
      out += `[${glob.slice(i + 1, close).replace(/^!/, '^')}]`
      i = close + 1
    } else {
      out += GLOB_CHARS[char] ?? escape(char)
      i += 1
    }
  }
  return out
}

function globRegex(glob: string, anyDepth: boolean): RegExp {
  const parts = glob.split('/').filter((part) => part !== '')
  const body = parts
    .map((part, i) => {
      const last = i === parts.length - 1
      if (part === '**') {
        return last ? '.*' : '(?:[^/]*/)*'
      }
      return `${segment(part)}${last ? '' : '/'}`
    })
    .join('')
  return new RegExp(`^${anyDepth ? '(?:.*/)?' : ''}${body}$`, 's')
}

interface Base {
  root: string
  glob: string
  anyDepth: boolean
}

/** Where a gitignore-style pattern starts, and whether a relative one matches at any depth. */
function baseOf(pattern: string, behavior: RuleBehavior, scope: PathScope): Base | null {
  if (pattern.startsWith('!')) {
    return null
  }
  if (pattern === '*' || pattern === '**') {
    return { root: '/', glob: '**', anyDepth: false }
  }
  if (pattern.startsWith('//')) {
    return { root: '/', glob: pattern.slice(2), anyDepth: false }
  }
  if (pattern === '~' || pattern.startsWith('~/')) {
    return { root: scope.home, glob: pattern.slice(2), anyDepth: false }
  }
  if (pattern.startsWith('/')) {
    return { root: scope.anchor, glob: pattern.slice(1), anyDepth: false }
  }
  if (pattern.startsWith('./')) {
    return { root: scope.cwd, glob: pattern.slice(2), anyDepth: false }
  }
  const parts = (pattern.endsWith('/') ? pattern.slice(0, -1) : pattern).split('/')
  const oneDir = parts.length === 2 && parts[1] === '**' && behavior !== 'allow'
  return { root: scope.cwd, glob: pattern, anyDepth: parts.length === 1 || oneDir }
}

const ancestors = (relative: string) => {
  const parts = relative.split('/')
  return parts.map((_, i) => parts.slice(0, i + 1).join('/'))
}

/**
 * Whether a `Read` or `Edit` pattern covers an absolute path, in gitignore syntax: `//` from the
 * root, `~/` from home, `/` from the rule's settings source, else from the cwd. A deny or ask
 * pattern also covers what lies inside a directory it names; an allow pattern only what it names.
 */
export function pathMatches(pattern: string, target: string, behavior: RuleBehavior, scope: PathScope): boolean {
  const base = baseOf(pattern.trim(), behavior, scope)
  if (base === null || !insideAny(target, [base.root])) {
    return false
  }
  const relative = base.root === '/' ? target.slice(1) : path.relative(base.root, target)
  const regex = globRegex(base.glob, base.anyDepth)
  const candidates = behavior === 'allow' || relative === '' ? [relative] : ancestors(relative)
  return candidates.some((candidate) => regex.test(candidate))
}
