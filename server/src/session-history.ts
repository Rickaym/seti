import type { SDKAssistantMessage, SDKUserMessage, SessionMessage } from '@anthropic-ai/claude-agent-sdk'
import { findPrUrls } from '@seti/shared'
import { z } from 'zod'
import type { BackfillMessage } from './db.js'
import { createPrWatcher } from './pr-link.js'

const block = z.looseObject({ type: z.string() })
type Block = z.infer<typeof block>

const apiMessage = z.looseObject({ content: z.union([z.string(), z.array(block)]) })
const stamped = z.looseObject({ timestamp: z.string().optional() })

/** Terminal bookkeeping Claude Code stores as user text; none of it is something the user typed. */
const META_TAGS = new Set([
  'local-command-stdout',
  'local-command-stderr',
  'local-command-caveat',
  'task-notification',
  'system-reminder',
  'bash-stdout',
  'bash-stderr',
])

const tagged = (text: string, tag: string) =>
  new RegExp(String.raw`<${tag}>([\s\S]*?)</${tag}>`).exec(text)?.[1]?.trim() ?? null

/** What the user typed, with slash commands and shell escapes shown the way they were entered. */
export function promptText(raw: string): string | null {
  const text = raw.trim()
  const command = tagged(text, 'command-name')
  if (command !== null) {
    const args = tagged(text, 'command-args') ?? ''
    return args === '' ? command : `${command} ${args}`
  }
  const shell = tagged(text, 'bash-input')
  if (shell !== null) {
    return `! ${shell}`
  }
  const leading = /^<([\w-]+)>/.exec(text)?.[1]
  if (text === '' || (leading !== undefined && META_TAGS.has(leading))) {
    return null
  }
  return text
}

const blockText = (b: Block): string => {
  if (b.type === 'text' && typeof b.text === 'string') {
    return b.text
  }
  return b.type === 'image' ? '[image]' : ''
}

// Session files store the objects the SDK streams; only the fields read here are checked.
const asUserMessage = (value: object) => value as SDKUserMessage
const asAssistantMessage = (value: object) => value as SDKAssistantMessage

const timestampOf = (m: SessionMessage) => stamped.safeParse(m).data?.timestamp ?? null

function userBody(m: SessionMessage, content: string | Block[]): BackfillMessage['body'] | null {
  if (typeof content === 'string') {
    const text = promptText(content)
    return text === null ? null : { kind: 'prompt', payload: { text } }
  }
  const results = content.filter((b) => b.type === 'tool_result')
  if (results.length === 0) {
    const text = promptText(content.map(blockText).join('\n'))
    return text === null ? null : { kind: 'prompt', payload: { text } }
  }
  const payload = {
    type: 'user',
    message: { role: 'user', content: results },
    parent_tool_use_id: m.parent_tool_use_id,
    uuid: m.uuid,
    session_id: m.session_id,
  }
  return { kind: 'sdk', payload: asUserMessage(payload) }
}

const shown = (b: Block) => b.type === 'tool_use' || (b.type === 'text' && blockText(b).trim() !== '')

function assistantBody(m: SessionMessage, message: z.infer<typeof apiMessage>): BackfillMessage['body'] | null {
  const content = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content
  const kept = content.filter(shown)
  if (kept.length === 0) {
    return null
  }
  const payload = {
    type: 'assistant',
    message: { ...message, content: kept },
    parent_tool_use_id: m.parent_tool_use_id,
    uuid: m.uuid,
    session_id: m.session_id,
  }
  return { kind: 'sdk', payload: asAssistantMessage(payload) }
}

/** Transcript rows for a session's messages; thinking, system notes and bookkeeping are left out. */
export function sessionHistory(raw: readonly SessionMessage[]): BackfillMessage[] {
  return raw.flatMap((m) => {
    const message = apiMessage.safeParse(m.message)
    if (!message.success || m.type === 'system') {
      return []
    }
    const body = m.type === 'user' ? userBody(m, message.data.content) : assistantBody(m, message.data)
    return body === null ? [] : [{ body, at: timestampOf(m) }]
  })
}

export interface SessionPrs {
  created: string[]
  mentioned: string[]
}

/** PRs that `gh pr create` printed in the session, and every other PR URL it mentions. */
export function sessionPrs(raw: readonly SessionMessage[], history: readonly BackfillMessage[]): SessionPrs {
  const watch = createPrWatcher()
  const created = new Set<string>()
  for (const { body } of history) {
    for (const pr of body.kind === 'sdk' ? watch('session', body.payload) : []) {
      created.add(pr.url)
    }
  }
  const mentioned = new Set(raw.flatMap((m) => findPrUrls(JSON.stringify(m.message ?? null))))
  return { created: [...created], mentioned: [...mentioned].filter((url) => !created.has(url)) }
}

/** Times of the first and last message that carry one. */
export function sessionSpan(raw: readonly SessionMessage[]): { first: string | null; last: string | null } {
  const times = raw.map(timestampOf).filter((t) => t !== null)
  return { first: times[0] ?? null, last: times.at(-1) ?? null }
}
