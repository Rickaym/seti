import { randomUUID } from 'node:crypto'
import os from 'node:os'
import { denial, fire, type FakeHooks } from './fake-repeat.js'
import type { StepActor } from './fake-steps.js'

/** What a prompt asks for to get a turn that pushes to the GitHub owner it names next. */
export const OUTSIDE_PUSH_PROMPT = 'send this branch outside, to'
export const PUSHED = 'Pushed.'

/** The `owner/repo` a push prompt names, such as "push the fix to acme/tool". */
const targetOf = (prompt: string) =>
  new RegExp(`${OUTSIDE_PUSH_PROMPT} ([\\w.-]+/[\\w.-]+)`).exec(prompt)?.[1] ?? 'acme/tool'

/** Pushes to the repository the prompt names by URL, after Seti's PreToolUse hooks. */
export async function pushElsewhere(hooks: FakeHooks | undefined, prompt: string, act: StepActor): Promise<void> {
  const id = `toolu_push_${randomUUID().slice(0, 8)}`
  const input = { command: `git push https://github.com/${targetOf(prompt)} HEAD:main`, description: 'Push the fix' }
  act.assistant([{ type: 'tool_use', id, name: 'Bash', input }])
  const event = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: input, cwd: os.tmpdir() }
  const refused = denial(await fire(hooks, event, id))
  if (act.ended()) {
    return
  }
  if (refused !== undefined) {
    act.toolResult(id, refused)
    act.assistant([{ type: 'text', text: `Not pushed: ${refused}` }])
    return
  }
  act.toolResult(id, 'main -> main')
  act.assistant([{ type: 'text', text: PUSHED }])
}
