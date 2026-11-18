import type { HookCallback, HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk'

/** The longest a command's `timeout` may be, which Seti raises from Claude Code's 2 hours. */
export const COMMAND_LIMIT_HOURS = 24

/** Rules the shell guard or Claude Code enforces, each with its reason, for every agent. */
const RULES = [
  "Seti's house rules, which hold for you and every subagent:",
  '- Never wait with a foreground sleep or a polling loop, which Claude Code refuses: start a long command ' +
    `with run_in_background (it stops at its timeout, 30 minutes unless you set one, at most ${String(COMMAND_LIMIT_HOURS)} ` +
    'hours) and end the turn, since you are told when it exits.',
  '- Stop a process by its exact PID, never with pkill or killall, because a name or pattern also matches ' +
    "other agents' processes and Seti's.",
  '- Give rm -r a literal path inside your own directories, never one a variable or command builds, ' +
    'because Seti cannot tell where that points and refuses it.',
  '- Tool names are case sensitive: the shell tool is Bash, and a call to bash fails.',
].join('\n')

const BRIEF = 'Put these rules in the brief of every subagent you start, because a subagent does not read this prompt.'

/** The house rules as every agent's system prompt carries them, sandboxed or not. */
export const houseRulesContext = (): string => `${RULES}\n${BRIEF}`

/** A SubagentStart hook that gives each subagent the house rules its parent's prompt carries. */
export function subagentRules(): HookCallbackMatcher {
  const hook: HookCallback = async (input) =>
    Promise.resolve(
      input.hook_event_name === 'SubagentStart'
        ? { hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: houseRulesContext() } }
        : {},
    )
  return { hooks: [hook] }
}
