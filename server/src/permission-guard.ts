import os from 'node:os'
import path from 'node:path'
import type { HookCallback, HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk'
import { protectedWrite } from './protected-writes.js'
import { cdTarget, commandWords, expandHome, type SimpleCommand } from './shell-words.js'

/** Where an agent may remove or write trees: its own directories and the temporary one. */
export interface GuardScope {
  home: string
  /** The agent's working directory, repos, added directories and workspace. */
  roots: readonly string[]
  /** Credentials no shell command of an agent writes under. */
  protectedDirs: readonly string[]
  /** Bwrap holds the agent, so commands that run other programs need no backstop. */
  sandboxed: boolean
}

const SEPARATORS = /&&|\|\||[;&|\n()]/
const KILL_BY_NAME = /(^|[\s;&|(`$'"])(pkill|killall)(\s|$)/
const COMPUTED = /[$`]/
const GLOB = /[*?[]/
const unquote = (word: string) => word.replace(/^['"]|['"]$/g, '')

const simpleCommand = (segment: string): SimpleCommand =>
  commandWords(segment.trim().split(/\s+/).filter(Boolean).map(unquote))

const isRecursive = (flag: string) =>
  flag === '--recursive' || (/^-[A-Za-z]+$/.test(flag) && (flag.includes('r') || flag.includes('R')))

const inside = (target: string, root: string) => target.startsWith(`${root}/`)

const tmpRoots = () => [...new Set(['/tmp', os.tmpdir()])]

/** Why touching `target` from `cwd` is refused, or null when it lies in the agent's directories. */
function pathProblem(target: string, cwd: string | null, scope: GuardScope): string | null {
  if (COMPUTED.test(target)) {
    return `${target} is made by a variable or command, so Seti cannot tell where it points`
  }
  const literal = GLOB.test(target) ? target.slice(0, target.search(GLOB)) : target
  const expanded = expandHome(literal, scope.home)
  if (!path.isAbsolute(expanded) && cwd === null) {
    const relative = path.normalize(expanded)
    return relative === '.' || relative === '' || relative.startsWith('..')
      ? `${target} leaves the working directory`
      : null
  }
  const resolved = path.resolve(cwd ?? '/', expanded)
  const allowed = [...scope.roots, ...tmpRoots()].some((root) => inside(resolved, root))
  return allowed ? null : `${target} is outside the agent's directories`
}

function removals(command: SimpleCommand, cwd: string | null, scope: GuardScope): string | null {
  if (command.xargs) {
    return "xargs rm refused: Seti cannot see what it removes. Remove files inside the agent's directories by literal path."
  }
  const args = command.words.slice(1)
  if (!args.filter((word) => word.startsWith('-')).some(isRecursive)) {
    return null
  }
  const problem = args
    .filter((word) => !word.startsWith('-'))
    .map((target) => pathProblem(target, cwd, scope))
    .find((found) => found !== null)
  return problem === undefined
    ? null
    : `rm -r refused: ${problem}. Remove files inside the agent's directories by literal path.`
}

/** Where `--output` sends a file, which must stay in the agent's directories. */
function outputs(words: readonly string[], cwd: string | null, scope: GuardScope): string | null {
  const targets = words.flatMap((word, index) => {
    if (word.startsWith('--output=')) {
      return [word.slice('--output='.length)]
    }
    return word === '--output' ? [words[index + 1] ?? ''] : []
  })
  const problem = targets.map((target) => pathProblem(target, cwd, scope)).find((found) => found !== null)
  return problem === undefined ? null : `--output refused: ${problem}.`
}

const FIND_RUNS = new Set(['-exec', '-execdir', '-ok', '-okdir', '-delete'])
const RG_RUNS = /^--pre(-glob)?(=|$)/

/** Commands that run other programs or delete trees through a flag; bwrap holds a sandboxed one. */
function runsOthers(words: readonly string[], scope: GuardScope): string | null {
  const [name, ...args] = words
  if (name === 'git' && args.includes('clean') && args.some((arg) => /^-[a-zA-Z]*f/.test(arg))) {
    return 'git clean -f refused: it deletes untracked and ignored files, which may be the only copy.'
  }
  if (scope.sandboxed) {
    return null
  }
  if (name === 'find' && args.some((arg) => FIND_RUNS.has(arg))) {
    return 'find -exec and -delete refused outside the sandbox; list the files, then act on them by path.'
  }
  if ((name === 'rg' || name === 'ripgrep') && args.some((arg) => RG_RUNS.test(arg))) {
    return 'rg --pre refused outside the sandbox: it runs a program on every file.'
  }
  if (name === 'gh' && args.some((arg) => arg === '--web' || arg.startsWith('--web='))) {
    return 'gh --web refused outside the sandbox: it starts a browser program.'
  }
  return null
}

function segmentProblem(command: SimpleCommand, cwd: string | null, scope: GuardScope): string | null {
  if (command.words[0] === 'rm') {
    return removals(command, cwd, scope)
  }
  return outputs(command.words, cwd, scope) ?? runsOthers(command.words, scope)
}

function segmentsCheck(command: string, scope: GuardScope): string | null {
  let cwd: string | null = null
  for (const segment of command.split(SEPARATORS)) {
    const simple = simpleCommand(segment)
    if (simple.words[0] === 'cd') {
      cwd = cdTarget(simple.words, cwd, scope.home)
    } else {
      const problem = segmentProblem(simple, cwd, scope)
      if (problem !== null) {
        return problem
      }
    }
  }
  return null
}

/** Text in quotes runs only through a shell or eval; elsewhere it is a message or an argument. */
const RUNS_QUOTED = /(^|\s)(eval|sh|bash|zsh|dash)(\s|$)/
const QUOTED = /'[^']*'|"[^"]*"/g

/** The command as it runs: quoted text dropped unless a shell or eval may run it. */
const runnable = (command: string) => (RUNS_QUOTED.test(command) ? command : command.replace(QUOTED, "''"))

/** Scripts a shell -c or eval runs, which the guard checks as commands of their own. */
const SHELL_SCRIPT = /\b(?:ba|z|da)?sh\s+(?:-\w+\s+)*-\w*c\s+('[^']*'|"[^"]*")/g
const EVAL_SCRIPT = /\beval\s+('[^']*'|"[^"]*")/g
const NESTING = 3

const innerScripts = (command: string) =>
  [...command.matchAll(SHELL_SCRIPT), ...command.matchAll(EVAL_SCRIPT)]
    .map((match) => (match[1] ?? '').slice(1, -1))
    .filter((script) => script !== '')

function guardAt(command: string, scope: GuardScope, depth: number): string | null {
  if (KILL_BY_NAME.test(runnable(command))) {
    return 'Agents do not kill processes by name, which can stop other agents and Seti; kill a PID you started.'
  }
  if (/(^|[\s;&|(])(GH_)?BROWSER=/.test(command) && !scope.sandboxed) {
    return 'Setting BROWSER or GH_BROWSER refused outside the sandbox: it names a program to run.'
  }
  const own = segmentsCheck(command, scope) ?? protectedWrite(command, scope)
  if (own !== null || depth >= NESTING) {
    return own
  }
  return innerScripts(command)
    .map((script) => guardAt(script, scope, depth + 1))
    .reduce<string | null>((found, next) => found ?? next, null)
}

/** Why Seti refuses the command whatever the permission rules say, or null when it does not. */
export const guardCommand = (command: string, scope: GuardScope): string | null => guardAt(command, scope, 0)

const commandOf = (input: unknown): string | null =>
  typeof input === 'object' && input !== null && 'command' in input && typeof input.command === 'string'
    ? input.command
    : null

/** True when the guard refuses the call, which then never runs. */
export function guardRefuses(tool: string, input: unknown, scope: GuardScope): boolean {
  const command = tool === 'Bash' ? commandOf(input) : null
  return command !== null && guardCommand(command, scope) !== null
}

/** Called with each command the guard refuses and why. */
type Refused = (command: string, reason: string) => Promise<void>

/** A PreToolUse hook that refuses guarded shell commands before any rule or prompt sees them. */
export function bashGuard(scope: GuardScope, refused: Refused): HookCallbackMatcher {
  const hook: HookCallback = async (input) => {
    const command = input.hook_event_name === 'PreToolUse' ? commandOf(input.tool_input) : null
    const reason = command === null ? null : guardCommand(command, scope)
    if (command === null || reason === null) {
      return {}
    }
    await refused(command, reason)
    return {
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
    }
  }
  return { matcher: 'Bash', hooks: [hook] }
}
