import path from 'node:path'
import { cdTarget, commandWords, expandHome, shellCommands, type Redirect, type ShellCommand } from './shell-words.js'

/** Directories no shell command of an agent writes under, and the home `~` stands for. */
export interface ProtectedScope {
  home: string
  protectedDirs: readonly string[]
}

/** Commands that write, move or remove the files they are given. */
const WRITE_COMMANDS = new Set([
  'tee',
  'cp',
  'mv',
  'rm',
  'rmdir',
  'ln',
  'chmod',
  'chown',
  'touch',
  'mkdir',
  'install',
  'rsync',
  'dd',
  'truncate',
  'unlink',
])

const WRITE_REDIRECTS = new Set(['>', '>>', '>|', '&>', '&>>', '<>', '>&'])

/** `>&2` and `2>&1` copy a descriptor; `>& file` sends both outputs to a file. */
const writesFile = ({ op, target }: Redirect) => WRITE_REDIRECTS.has(op) && !(op === '>&' && /^(\d+|-)$/.test(target))

const inPlaceSed = (words: readonly string[]) =>
  words[0] === 'sed' && words.some((word) => /^-[a-zA-Z]*i/.test(word) || word.startsWith('--in-place'))

const writes = (words: readonly string[]) => WRITE_COMMANDS.has(words[0] ?? '') || inPlaceSed(words)

/** The arguments a writing command may write to, with the value of each `--flag=value` and `of=`. */
function writtenArgs(words: readonly string[]): string[] {
  if (!writes(words)) {
    return []
  }
  return words.slice(1).flatMap((arg) => {
    const value = arg.includes('=') ? [arg.slice(arg.indexOf('=') + 1)] : []
    return arg.startsWith('-') ? value : [arg, ...value]
  })
}

/** The protected directory `target` lies in, read from `cwd`; undefined when it lies in none. */
function protectedDirOf(target: string, cwd: string | null, scope: ProtectedScope): string | undefined {
  const expanded = expandHome(target, scope.home)
  if (!path.isAbsolute(expanded) && cwd === null) {
    return undefined
  }
  const resolved = path.resolve(cwd ?? '/', expanded)
  return scope.protectedDirs.find((dir) => resolved === dir || resolved.startsWith(`${dir}/`))
}

/** The ways a command can name a directory under the home directory. */
function spellings(dir: string, home: string): string[] {
  const relative = dir.startsWith(`${home}/`) ? dir.slice(home.length + 1) : null
  return relative === null ? [dir] : [dir, `~/${relative}`, `$HOME/${relative}`, `\${HOME}/${relative}`]
}

const namedDir = (line: string, scope: ProtectedScope) =>
  scope.protectedDirs.find((dir) => spellings(dir, scope.home).some((spelling) => line.includes(spelling)))

/** The protected directory one simple command writes under, or undefined. */
function commandWrite(command: ShellCommand, cwd: string | null, line: string, scope: ProtectedScope) {
  const { words, xargs } = commandWords(command.words)
  const targets = [...command.redirects.filter(writesFile).map((redirect) => redirect.target), ...writtenArgs(words)]
  const hit = targets.map((target) => protectedDirOf(target, cwd, scope)).find((dir) => dir !== undefined)
  // xargs hands the writing command paths no one sees, so naming the directory anywhere counts.
  return hit ?? (xargs && writes(words) ? namedDir(line, scope) : undefined)
}

function lineWrite(line: string, scope: ProtectedScope): string | undefined {
  let cwd: string | null = null
  for (const command of shellCommands(line)) {
    const { words } = commandWords(command.words)
    if (words[0] === 'cd') {
      cwd = cdTarget(words, cwd, scope.home)
      continue
    }
    const dir = commandWrite(command, cwd, line, scope)
    if (dir !== undefined) {
      return dir
    }
  }
  return undefined
}

/** Substitutions run inside double quotes too; single quotes and backslashes keep them text. */
const SUBSTITUTION = /\$\(([^()]*)\)|`([^`]*)`/g
const substitutions = (line: string) =>
  [
    ...line
      .replace(/\\./g, '')
      .replace(/'[^']*'/g, "''")
      .matchAll(SUBSTITUTION),
  ].map((match) => match[1] ?? match[2] ?? '')

/**
 * Why the line writes under a protected directory, or null. Only a redirection or a writing
 * command whose target lies there counts, so reading those files is fine.
 */
export function protectedWrite(line: string, scope: ProtectedScope): string | null {
  const dir = [line, ...substitutions(line)]
    .map((script) => lineWrite(script, scope))
    .find((found) => found !== undefined)
  return dir === undefined ? null : `Agents do not write under ${dir}; ask the user to change it themselves.`
}
