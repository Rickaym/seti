import { createHash } from 'node:crypto'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import {
  findPrUrls,
  type EaDocKind,
  type MessageRow,
  type PromptPayload,
  type SubtaskBrief,
  type Task,
  type TaskInput,
} from '@seti/shared'
import type { OpenPr } from './github.js'
import { redactCredentials } from './scrub.js'
import type { IndexDoc } from './store/ea-index.js'

const CHUNK_CHARS = 1400
const MIN_AGENT_CHARS = 60
const MIN_PROMPT_CHARS = 12

const hashOf = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 32)

const normalise = (text: string) =>
  redactCredentials(text)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

/** Splits at paragraphs, then at sentence ends or spaces, into pieces of at most `max` chars. */
export function chunkText(text: string, max = CHUNK_CHARS): string[] {
  const pieces: string[] = []
  let current = ''
  const flush = () => {
    if (current.trim() !== '') {
      pieces.push(current.trim())
    }
    current = ''
  }
  for (const paragraph of normalise(text).split('\n\n')) {
    let rest = paragraph.trim()
    while (rest.length > max) {
      const window = rest.slice(0, max)
      const cut = Math.max(window.lastIndexOf('. '), window.lastIndexOf('\n'), window.lastIndexOf(' '))
      const at = cut > max / 2 ? cut + 1 : max
      flush()
      pieces.push(rest.slice(0, at).trim())
      rest = rest.slice(at).trim()
    }
    if (current.length + rest.length + 2 > max) {
      flush()
    }
    current = current === '' ? rest : `${current}\n\n${rest}`
  }
  flush()
  return pieces
}

type TaskRef = Pick<Task, 'id' | 'title' | 'repo_slug'>

interface Source {
  task: TaskRef
  row: MessageRow
  /** Which part of the message, so each block of a message gets its own keys. */
  part: string
  kind: EaDocKind
  pr_url?: string | null
}

function docsOf(source: Source, text: string): IndexDoc[] {
  const { task, row } = source
  return chunkText(text).map((body, index) => ({
    key: `m:${String(row.id)}:${source.part}:${String(index)}`,
    scope: `task:${task.id}`,
    kind: source.kind,
    task_id: task.id,
    message_id: row.id,
    pr_url: source.pr_url ?? null,
    repo: task.repo_slug,
    title: task.title,
    body,
    hash: hashOf(body),
    at: row.created_at,
  }))
}

interface ContentBlock {
  type: string
  text?: string
  tool_use_id?: string
  content?: unknown
}

/** Claude Code ends a subagent's report with its id and usage; neither is worth searching. */
function withoutTrailer(text: string): string {
  const usage = text.indexOf('<usage>')
  const body = usage === -1 ? text : text.slice(0, usage)
  return body
    .split('\n')
    .filter((line) => !line.startsWith('agentId: '))
    .join('\n')
}

function blockText(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return ''
  }
  const parts = (content as ContentBlock[]).map((part) =>
    part.type === 'text' && typeof part.text === 'string' ? part.text : '',
  )
  return withoutTrailer(parts.join('\n'))
}

const long = (text: string, min: number) => text.trim().length >= min

type Subagents = ReadonlyMap<string, string>

function reportDocs(task: TaskRef, row: MessageRow, blocks: readonly ContentBlock[], subagents: Subagents) {
  return blocks.flatMap((block, index) => {
    const about = block.type === 'tool_result' ? subagents.get(block.tool_use_id ?? '') : undefined
    const report = about === undefined ? '' : blockText(block.content)
    const source: Source = { task, row, part: String(index), kind: 'subagent' }
    return long(report, MIN_AGENT_CHARS) ? docsOf(source, `Subagent report, ${about ?? ''}:\n\n${report}`) : []
  })
}

function sdkDocs(task: TaskRef, row: MessageRow, m: SDKMessage, subagents: Subagents): IndexDoc[] {
  if (m.type === 'assistant' && m.parent_tool_use_id === null) {
    return m.message.content.flatMap((block, index) =>
      block.type === 'text' && long(block.text, MIN_AGENT_CHARS)
        ? docsOf({ task, row, part: String(index), kind: 'agent' }, block.text)
        : [],
    )
  }
  if (m.type === 'result' && m.subtype === 'success' && long(m.result, MIN_AGENT_CHARS)) {
    return docsOf({ task, row, part: 'result', kind: 'result' }, m.result)
  }
  if (m.type !== 'user' || m.parent_tool_use_id !== null || typeof m.message.content === 'string') {
    return []
  }
  return reportDocs(task, row, m.message.content, subagents)
}

function promptDocs(task: TaskRef, row: MessageRow, prompt: PromptPayload): IndexDoc[] {
  const { text, auto, queued } = prompt
  const skip = auto === true || queued === 'removed' || text.trimStart().startsWith('/')
  return skip || !long(text, MIN_PROMPT_CHARS) ? [] : docsOf({ task, row, part: 'prompt', kind: 'prompt' }, text)
}

/** A direct message stays out of the index, which the EA and every agent at Full search. */
function inputDocs(task: TaskRef, row: MessageRow, input: TaskInput): IndexDoc[] {
  if (input.kind === 'ci_passed' || (input.source === 'team' && input.kind === 'direct')) {
    return []
  }
  const text = input.body === '' ? input.title : `${input.title}\n\n${input.body}`
  const pr_url = input.url === null ? null : (findPrUrls(input.url)[0] ?? null)
  return docsOf({ task, row, part: 'input', kind: 'pr_update', pr_url }, text)
}

/** Searchable text of task messages: what the user and agent wrote, reports and PR updates. */
export function taskDocs(task: TaskRef, rows: readonly MessageRow[], subagents: Subagents): IndexDoc[] {
  return rows.flatMap((row): IndexDoc[] => {
    switch (row.kind) {
      case 'prompt':
        return promptDocs(task, row, row.payload)
      case 'sdk':
        return sdkDocs(task, row, row.payload, subagents)
      case 'input':
        return inputDocs(task, row, row.payload)
      case 'seti':
      case 'shell':
      case 'notice':
      case 'unreadable':
        return []
    }
  })
}

/** A PR's description, one document per chunk, each carrying the PR's title. */
export function prDocs(pr: Pick<OpenPr, 'url' | 'repo_slug' | 'title' | 'updated_at' | 'body'>): IndexDoc[] {
  const body = normalise(pr.body ?? '')
  return chunkText(body === '' ? pr.title : body).map((chunk) => ({
    key: `pr:${pr.url}:body:${hashOf(chunk)}`,
    scope: `pr:${pr.url}`,
    kind: 'pr_body',
    task_id: null,
    message_id: null,
    pr_url: pr.url,
    repo: pr.repo_slug,
    title: pr.title,
    body: chunk,
    hash: hashOf(chunk),
    at: pr.updated_at,
  }))
}

/** Each subagent tool call of a task, named by its description and type. */
export function subagentNames(briefs: readonly SubtaskBrief[]): Map<string, string> {
  return new Map(
    briefs.flatMap((brief) => {
      const type = brief.subagent_type === null ? '' : ` (${brief.subagent_type})`
      const about = `"${brief.description}"${type}`
      return brief.tool_use_ids.map((id) => [id, about] as const)
    }),
  )
}
