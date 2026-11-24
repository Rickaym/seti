import { randomUUID } from 'node:crypto'
import { OUTSIDE_PUSH_PROMPT, pushElsewhere } from './fake-push.js'
import { REPEAT_PROMPT, repeatBuild, type FakeHooks } from './fake-repeat.js'
import type { StepActor } from './fake-steps.js'

/** What a prompt asks for to get a turn that sends a chat message through the MCP tool it names. */
export const REVIEW_PROMPT = 'post the deploy note with'
export const REVIEW_DRAFT = 'Deploy is dnoe'
export const reviewSent = (text: string) => `Sent: ${text}`

interface Decision {
  permissionDecision?: string
  permissionDecisionReason?: string
  updatedInput?: { text?: unknown }
}

/** The MCP tool a review prompt names, such as mcp__chat__send_message. */
const reviewTool = (prompt: string): string => /\bmcp__[\w-]+/.exec(prompt)?.[0] ?? 'mcp__chat__send_message'

/** Sends the draft through the tool after Seti's PreToolUse hooks, with any text the user edited. */
async function sendReviewed(hooks: FakeHooks | undefined, tool: string, act: StepActor): Promise<void> {
  const id = `toolu_review_${randomUUID().slice(0, 8)}`
  const input = { channel: 'C1', text: REVIEW_DRAFT }
  act.assistant([{ type: 'tool_use', id, name: tool, input }])
  const signal = new AbortController().signal
  const base = { session_id: 'fake', transcript_path: '', cwd: '', tool_use_id: id }
  const event = { ...base, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input }
  const matching = (hooks?.PreToolUse ?? []).filter(
    (m) => m.matcher === undefined || new RegExp(`^(?:${m.matcher})$`).test(tool),
  )
  const outputs = await Promise.all(matching.flatMap((m) => m.hooks.map(async (hook) => hook(event, id, { signal }))))
  if (act.ended()) {
    return
  }
  const decisions = outputs.map((output) => output.hookSpecificOutput as Decision | undefined)
  const refused = decisions.find((own) => own?.permissionDecision === 'deny')
  if (refused !== undefined) {
    act.toolResult(id, refused.permissionDecisionReason ?? 'Denied')
    act.assistant([{ type: 'text', text: 'Not sent.' }])
    return
  }
  const edited = decisions.find((own) => own?.updatedInput !== undefined)?.updatedInput?.text
  const text = typeof edited === 'string' ? edited : REVIEW_DRAFT
  act.toolResult(id, 'ok')
  act.assistant([{ type: 'text', text: reviewSent(text) }])
}

type HookTurn = (hooks: FakeHooks | undefined, act: StepActor) => Promise<void>

/** The turn a prompt asks for that runs through Seti's hooks: a repeated build, a push or a send. */
export function hookTurnOf(prompt: string): HookTurn | undefined {
  if (prompt.includes(REPEAT_PROMPT)) {
    return repeatBuild
  }
  if (prompt.includes(OUTSIDE_PUSH_PROMPT)) {
    return async (hooks, act) => pushElsewhere(hooks, prompt, act)
  }
  return prompt.includes(REVIEW_PROMPT) ? async (hooks, act) => sendReviewed(hooks, reviewTool(prompt), act) : undefined
}
