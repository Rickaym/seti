import { createHash } from 'node:crypto'
import {
  findPrUrls,
  type EaDocKind,
  type MessageRow,
  type PromptPayload,
  type SubtaskBrief,
  type Task,
  type TaskInput,
} from '@seti/shared'
import { rowEvents, type Of } from './events/read.js'
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

const long = (text: string, min: number) => text.trim().length >= min

type Subagents = ReadonlyMap<string, string>

/** A subagent's report, without the id and usage lines the runtime adds; worth no search. */
const reportOf = (end: Of<'tool.ended'>) => end.result.agent?.text ?? end.result.text

/** The agent's own words, the turn's reply, and the reports its subagents gave it, by part. */
function eventDocs(task: TaskRef, row: MessageRow, subagents: Subagents): IndexDoc[] {
  return rowEvents(row).flatMap((event, index): IndexDoc[] => {
    if (event.thread !== '') {
      return []
    }
    if (event.type === 'message' && event.role === 'agent' && long(event.text, MIN_AGENT_CHARS)) {
      return docsOf({ task, row, part: String(index), kind: 'agent' }, event.text)
    }
    if (event.type === 'turn.ended' && long(event.result, MIN_AGENT_CHARS)) {
      return docsOf({ task, row, part: 'result', kind: 'result' }, event.result)
    }
    const about = event.type === 'tool.ended' ? subagents.get(event.callId) : undefined
    const report = event.type === 'tool.ended' && about !== undefined ? reportOf(event) : ''
    const source: Source = { task, row, part: String(index), kind: 'subagent' }
    return long(report, MIN_AGENT_CHARS) ? docsOf(source, `Subagent report, ${about ?? ''}:\n\n${report}`) : []
  })
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
        return eventDocs(task, row, subagents)
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
