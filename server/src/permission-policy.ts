import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk'
import { permissionRuleText, type BuiltInRule, type PermissionBehavior, type PermissionRule } from '@seti/shared'

/** Tools that only read or plan, which every agent uses without asking; secrets stay denied. */
const READ_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'LS',
  'WebSearch',
  'TodoWrite',
  'Skill',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
  'mcp__seti',
]

/**
 * GitHub reads an agent outside the sandbox runs without asking. Nothing broader: the version
 * control CLI, rg, cat and their kind take flags that write files or run programs, such as
 * --output and --pre, which a prefix rule lets through, and Claude Code already runs their safe
 * forms without asking.
 */
const GH_READS = [
  'gh pr view',
  'gh pr list',
  'gh pr diff',
  'gh pr checks',
  'gh run list',
  'gh run view',
  'gh issue view',
  'gh issue list',
]

/** Tools the sandbox contains: its mounts bound edits and the egress proxy bounds the network. */
const SANDBOXED_TOOLS = ['Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch']

/** Killing processes by name hits other agents' and the user's processes too. */
const KILL_COMMANDS = ['pkill', 'killall']

/** Files whose settings or hooks run outside the sandbox; an agent outside it asks to edit them. */
const RUNS_UNSANDBOXED = [
  '**/.claude/settings.json',
  '**/.claude/settings.local.json',
  '**/.claude/hooks/**',
  '**/.mcp.json',
]

/** What the Bash guard refuses for every agent, in the words the settings page shows. */
export const GUARDS = [
  "rm -r on a path outside the agent's own directories, or on a path a variable or command makes",
  'Killing processes by name with pkill or killall',
  "Writing under ~/.ssh, ~/.aws, ~/.config or Seti's credentials, with a shell command or a file tool",
  "xargs rm, a forced clean of untracked files, and --output to a path outside the agent's directories",
  'Outside the sandbox: find -exec or -delete, rg --pre, gh --web, and setting BROWSER',
]

/** Built-in rules: read-only tools for all, the sandbox's tools inside it, and the kill denials. */
export function builtInRules(): BuiltInRule[] {
  const rule = (behavior: PermissionBehavior, text: string, applies: BuiltInRule['applies']) => ({
    behavior,
    rule: text,
    applies,
  })
  return [
    ...READ_TOOLS.map((tool) => rule('allow', tool, 'all')),
    ...SANDBOXED_TOOLS.map((tool) => rule('allow', tool, 'sandboxed')),
    ...GH_READS.map((command) => rule('allow', `Bash(${command}:*)`, 'unsandboxed')),
    ...RUNS_UNSANDBOXED.map((entry) => rule('ask', `Edit(//${entry})`, 'unsandboxed')),
    ...KILL_COMMANDS.map((command) => rule('deny', `Bash(${command}:*)`, 'all')),
  ]
}

/** The permissions settings Claude Code starts with, or takes mid-session when a rule changes. */
export type PermissionSettings = Record<PermissionBehavior, string[]>

interface RuleSources {
  builtIn: readonly BuiltInRule[]
  sandboxed: boolean
  /** Global rules, then the agent's own. */
  stored: readonly Pick<PermissionRule, 'behavior' | 'rule'>[]
  /** Deny rules Seti keeps whatever the user adds, such as for credentials. */
  fixedDeny: readonly string[]
}

const appliesTo = (rule: BuiltInRule, sandboxed: boolean) =>
  rule.applies === 'all' || (rule.applies === 'sandboxed') === sandboxed

/** Every rule an agent runs with, by behavior, each once. */
export function composeRules(sources: RuleSources): PermissionSettings {
  const rules = [...sources.builtIn.filter((rule) => appliesTo(rule, sources.sandboxed)), ...sources.stored]
  const of = (behavior: PermissionBehavior) => [
    ...new Set(rules.filter((rule) => rule.behavior === behavior).map((rule) => rule.rule)),
  ]
  return { allow: of('allow'), ask: of('ask'), deny: [...new Set([...of('deny'), ...sources.fixedDeny])] }
}

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

const isText = (value: unknown): value is string => typeof value === 'string' && value !== ''

const validRule = (text: string) => permissionRuleText.safeParse(text).success

const ruleText = (rule: { toolName: string; ruleContent?: string }) =>
  rule.ruleContent === undefined || rule.ruleContent === '' ? rule.toolName : `${rule.toolName}(${rule.ruleContent})`

/** A directory in rule syntax, where absolute paths start with //. */
const dirRule = (tool: string, dir: string) => `${FILE_TOOLS.has(tool) ? 'Edit' : 'Read'}(/${dir}/**)`

/** The allow rules a suggestion Claude Code made would add, in Seti's rule syntax. */
function suggestedRules(tool: string, update: PermissionUpdate): string[] {
  if (update.type === 'addRules' && update.behavior === 'allow') {
    return update.rules.map(ruleText)
  }
  if (update.type === 'addDirectories') {
    return update.directories.map((dir) => dirRule(tool, dir))
  }
  return []
}

function hostOf(url: unknown): string | null {
  if (!isText(url)) {
    return null
  }
  try {
    return new URL(url).hostname
  } catch {
    return null
  }
}

/** A rule for just this call when Claude Code suggested none. */
function fallbackRule(tool: string, input: Record<string, unknown>): string | null {
  if (tool.startsWith('mcp__')) {
    return tool
  }
  if (tool === 'Bash' && isText(input.command) && !input.command.includes('\n')) {
    return `Bash(${input.command})`
  }
  const host = tool === 'WebFetch' ? hostOf(input.url) : null
  if (host !== null) {
    return `WebFetch(domain:${host})`
  }
  return FILE_TOOLS.has(tool) && isText(input.file_path) ? `Edit(/${input.file_path})` : null
}

/** Tools whose approval is a one-off, such as a plan, so Always allow never applies. */
const ONE_OFF = new Set(['ExitPlanMode', 'EnterPlanMode'])

/** The rules Always allow would add for a call: Claude Code's suggestions, else one for the call. */
export function alwaysRules(
  tool: string,
  input: Record<string, unknown>,
  options: { suggestions?: PermissionUpdate[]; suppressAlwaysAllowRule?: boolean },
): string[] {
  if (options.suppressAlwaysAllowRule === true || ONE_OFF.has(tool)) {
    return []
  }
  const suggested = (options.suggestions ?? []).flatMap((update) => suggestedRules(tool, update))
  const rules = suggested.length > 0 ? suggested : [fallbackRule(tool, input) ?? '']
  return [...new Set(rules.filter(validRule))]
}
