import { randomUUID } from 'node:crypto'
import type { StepActor } from './fake-steps.js'

/** What a prompt asks for to get a turn that runs the same failing build three times. */
export const REPEAT_PROMPT = 'rerun the build until it passes'
export const REPEAT_COMMAND = 'pnpm build'
const REPEAT_OUTPUT = "src/app.ts(3,1): error TS2304: Cannot find name 'foo'."
export const REPEAT_DONE = 'Ran the build 3 times; it still fails.'
export const REPEAT_REASON = 'Runs the same Bash command again after 2 identical results'
const ATTEMPTS = 3

type HookOutput = Record<string, unknown> & {
  hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string }
}

type Hook = (input: Record<string, unknown>, toolUseId: string, options: { signal: AbortSignal }) => Promise<HookOutput>

/** Seti's hooks by event, as far as the stand-in calls them. */
export type FakeHooks = Partial<Record<string, { matcher?: string; hooks: Hook[] }[]>>

/** Runs the event's hooks that match the tool together, as Claude Code does. */
async function fire(hooks: FakeHooks | undefined, input: Record<string, unknown>, id: string): Promise<HookOutput[]> {
  const event = String(input.hook_event_name)
  const tool = String(input.tool_name)
  const matching = (hooks?.[event] ?? []).filter(
    (m) => m.matcher === undefined || new RegExp(`^(?:${m.matcher})$`).test(tool),
  )
  const signal = new AbortController().signal
  const base = { session_id: 'fake', transcript_path: '', cwd: '', tool_use_id: id }
  return Promise.all(matching.flatMap((m) => m.hooks.map(async (hook) => hook({ ...base, ...input }, id, { signal }))))
}

const denial = (outputs: readonly HookOutput[]) =>
  outputs.find((output) => output.hookSpecificOutput?.permissionDecision === 'deny')?.hookSpecificOutput
    ?.permissionDecisionReason

/** Runs the build three times with the same failure, asking Seti's hooks before and after each. */
export async function repeatBuild(hooks: FakeHooks | undefined, act: StepActor): Promise<void> {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    const id = `toolu_repeat_${randomUUID().slice(0, 8)}`
    const input = { command: REPEAT_COMMAND, description: `Build, try ${String(attempt)}` }
    act.assistant([{ type: 'tool_use', id, name: 'Bash', input }])
    const refused = denial(
      await fire(hooks, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: input }, id),
    )
    if (act.ended()) {
      return
    }
    if (refused !== undefined) {
      act.toolResult(id, refused)
      act.assistant([{ type: 'text', text: `Stopped: ${refused}` }])
      return
    }
    const output = { stdout: REPEAT_OUTPUT, stderr: '', interrupted: false }
    act.toolResult(id, REPEAT_OUTPUT, output)
    const done = { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: input, tool_response: output }
    await fire(hooks, done, id)
  }
  act.assistant([{ type: 'text', text: REPEAT_DONE }])
}
