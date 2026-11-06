import type { AuditDetail } from '@seti/shared'
import { bashCommand } from './outward.js'
import { scrubInput } from './scrub.js'

/** Characters of tool input text an outward audit event keeps, shared by every string field. */
export const INPUT_TEXT_BUDGET = 2000
const PREVIEW_LENGTH = 80
export const TRUNCATED = ' [truncated]'
const MAX_TARGET = 200
const MAX_INPUT_JSON = 3800
const MAX_ITEMS = 20
const MAX_DEPTH = 4

const TARGET_KEYS = ['channel_id', 'channel', 'to', 'recipient', 'recipients', 'email'] as const
const TEXT_KEYS = ['text', 'message', 'body', 'content', 'subject', 'markdown', 'comment', 'command'] as const
const THREAD_KEY = 'thread_ts'
const DIRECT_TOOL = 'mcp__seti__post_team_chat'

type Fields = Record<string, unknown>

const isFields = (value: unknown): value is Fields =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Hands out the shared character budget; a string past it is cut and marked. */
class Budget {
  truncated = false
  private left = INPUT_TEXT_BUDGET

  take(text: string): string {
    if (text.length <= this.left) {
      this.left -= text.length
      return text
    }
    const kept = text.slice(0, this.left)
    this.left = 0
    this.truncated = true
    return `${kept}${TRUNCATED}`
  }

  cut(): void {
    this.truncated = true
  }
}

function bound(value: unknown, budget: Budget, depth: number): unknown {
  if (typeof value === 'string') {
    return budget.take(value)
  }
  if (typeof value !== 'object' || value === null) {
    return value
  }
  if (depth >= MAX_DEPTH) {
    budget.cut()
    return TRUNCATED.trim()
  }
  const items = Array.isArray(value) ? value : Object.entries(value)
  if (items.length > MAX_ITEMS) {
    budget.cut()
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ITEMS).map((item) => bound(item, budget, depth + 1))
  }
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, MAX_ITEMS)
      .map(([key, item]) => [key, bound(item, budget, depth + 1)]),
  )
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

/** The first PREVIEW_LENGTH characters of text on one line. */
export function preview(text: string): string {
  const line = oneLine(text)
  return line.length > PREVIEW_LENGTH ? `${line.slice(0, PREVIEW_LENGTH - 3)}...` : line
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

/** `mcp__plugin_slack_slack__slack_send_message` reads as `Slack send_message`; others as named. */
export function toolDisplayName(name: string): string {
  const parts = name.split('__')
  const [prefix, rawServer, ...rest] = parts
  if (prefix !== 'mcp' || rawServer === undefined || rest.length === 0) {
    return name
  }
  let server = rawServer.replace(/^plugin_/, '').replace(/^claude_ai_/, '')
  const halves = server.split('_')
  const half = halves.length % 2 === 0 ? halves.length / 2 : 0
  if (half > 0 && halves.slice(0, half).join('_') === halves.slice(half).join('_')) {
    server = halves.slice(0, half).join('_')
  }
  const tool = rest.join('__')
  const prefixed = `${server.toLowerCase()}_`
  const action = tool.toLowerCase().startsWith(prefixed) ? tool.slice(prefixed.length) : tool
  return `${capitalize(server.replace(/_/g, ' '))} ${action}`
}

const textOf = (value: unknown): string | null => {
  if (typeof value === 'string' && value.trim() !== '') {
    return value
  }
  if (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string')) {
    return value.join(', ')
  }
  return null
}

const firstKey = (fields: Fields, keys: readonly string[]) => keys.find((key) => textOf(fields[key]) !== null)

function targetOf(fields: Fields): { target: string | null; keys: string[] } {
  const key = firstKey(fields, TARGET_KEYS)
  const thread = textOf(fields[THREAD_KEY])
  if (key === undefined) {
    return { target: null, keys: [] }
  }
  const where = oneLine(textOf(fields[key]) ?? '')
  const target = thread === null ? where : `${where} thread ${thread}`
  return { target: target.slice(0, MAX_TARGET), keys: thread === null ? [key] : [key, THREAD_KEY] }
}

interface OutwardRecord {
  summary: string
  /** `target`, `text`, `input` (JSON of the remaining fields) and `truncated`, when present. */
  detail: AuditDetail
}

interface Split {
  target: string | null
  text: string | null
  /** The fields not shown as target or text; undefined when none are left. */
  rest: unknown
  /** The text the summary previews: the sent text, else the first other string field. */
  shown: string | null
}

/** Picks the target and text out of a tool input; text takes the budget first. */
function split(input: unknown, budget: Budget): Split {
  if (!isFields(input)) {
    return { target: null, text: null, rest: input, shown: null }
  }
  const textKey = firstKey(input, TEXT_KEYS)
  const { target, keys } = targetOf(input)
  const text = textKey === undefined ? null : budget.take(textOf(input[textKey]) ?? '')
  const used = new Set<string>(textKey === undefined ? keys : [...keys, textKey])
  const others = Object.entries(input).filter(([key]) => !used.has(key))
  const fallback = others.map(([, value]) => textOf(value)).find((value) => value !== null) ?? null
  return {
    target,
    text,
    rest: others.length === 0 ? undefined : Object.fromEntries(others),
    shown: text ?? fallback,
  }
}

function inputJson(rest: unknown, budget: Budget): string {
  const json = JSON.stringify(bound(rest, budget, 0))
  if (json.length <= MAX_INPUT_JSON) {
    return json
  }
  budget.cut()
  return `${json.slice(0, MAX_INPUT_JSON)}${TRUNCATED}`
}

/** A direct group chat message keeps its text out of the audit log, as Seti's own record does. */
function directRecord(name: string, input: unknown): OutwardRecord | null {
  if (name !== DIRECT_TOOL || !isFields(input) || typeof input.to !== 'string' || input.to.trim() === '') {
    return null
  }
  const length = typeof input.text === 'string' ? input.text.length : 0
  const target = input.to.slice(0, MAX_TARGET)
  const summary = `${toolDisplayName(name)} \u2192 ${target}: a direct message of ${String(length)} characters`
  return { summary, detail: { target, length } }
}

/** What an outward tool call sent and where, scrubbed and bounded, and a one-line summary of it. */
export function outwardRecord(name: string, input: unknown): OutwardRecord {
  const direct = directRecord(name, input)
  if (direct !== null) {
    return direct
  }
  const scrubbed = scrubInput(input)
  const budget = new Budget()
  const { target, text, rest, shown } = split(scrubbed, budget)
  const detail: AuditDetail = {
    ...(target === null ? {} : { target }),
    ...(text === null ? {} : { text }),
    ...(rest === undefined ? {} : { input: inputJson(rest, budget) }),
  }
  if (budget.truncated) {
    detail.truncated = true
  }
  return { summary: summaryOf(name, target, shown, scrubbed), detail }
}

function summaryOf(name: string, target: string | null, shown: string | null, input: unknown): string {
  if (name === 'Bash') {
    return `Bash: ${bashCommand(input)}`
  }
  const where = target === null ? '' : ` \u2192 ${target}`
  const what = shown === null ? '' : `: "${preview(shown)}"`
  return `${toolDisplayName(name)}${where}${what}`
}
