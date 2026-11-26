import type { ToolCall } from '@seti/shared'
import { at, isoTime, isRecord, parseJson, stringAt, type FoundItem, type ParseResult } from './item.js'
import { isLinearId, linearCommentRef, linearRef } from './refs.js'

const LINEAR = /linear/i
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** The team key of an identifier such as `ENG-12`. */
const teamOf = (id: string) => id.slice(0, id.indexOf('-'))

const ISSUE_URL = /^https:\/\/linear\.app\/([\w-]{1,64})\/issue\/([A-Z][A-Z0-9]{0,9}-\d{1,9})(?:\/[\w-]*)?$/

/** The workspace key of an issue's own URL, when it names that issue's identifier. */
function stated(record: Record<string, unknown>): { url: string; key: string } | null {
  const url = stringAt(record, 'url') ?? ''
  const found = ISSUE_URL.exec(url)
  const named = found?.[2]
  return found !== null && named !== undefined && (record.id === named || record.identifier === named)
    ? { url, key: found[1] ?? '' }
    : null
}

/** The issue's own URL, else one built on the workspace key the agent's Linear answers stated. */
function issueUrl(record: Record<string, unknown>, id: string, key: string | null): string {
  const own = stated(record)
  if (own !== null) {
    return own.url
  }
  return key === null ? '' : `https://linear.app/${key}/issue/${id}`
}

/**
 * The workspace URL key a Linear answer states in its issues' own `url` fields, at the top or in
 * `issues`; null when it states none, or more than one.
 */
export function linearKeyIn(text: string): string | null {
  const parsed = parseJson(text)
  if (!isRecord(parsed)) {
    return null
  }
  const issues: unknown[] = Array.isArray(parsed.issues) ? parsed.issues : []
  const keys = new Set([parsed, ...issues].flatMap((entry) => (isRecord(entry) ? (stated(entry)?.key ?? []) : [])))
  const [key, ...more] = keys
  return more.length === 0 ? (key ?? null) : null
}

/** An issue as a get or a list states it: its identifier, its URL, and its title and description. */
function issue(record: Record<string, unknown>, path: readonly (string | number)[], key: string | null): FoundItem[] {
  const id = record.id
  if (!isLinearId(id)) {
    return []
  }
  const spans = ['title', 'description'].flatMap((field) =>
    typeof record[field] === 'string' ? [at([...path, field])] : [],
  )
  const time = isoTime(stringAt(record, 'createdAt'))
  return spans.length === 0
    ? []
    : [
        {
          kind: 'linear',
          container: teamOf(id),
          ref: linearRef(id),
          permalink: issueUrl(record, id, key),
          at: time,
          spans,
        },
      ]
}

/** The issue a get answers with, when it is the one the call asked for by identifier. */
function getIssue(asked: unknown): ParseResult {
  return (text, key) => {
    const parsed = parseJson(text)
    const fits = isRecord(parsed) && (!isLinearId(asked) || parsed.id === asked)
    return fits ? issue(parsed, [], key) : []
  }
}

function listIssues(text: string, key: string | null): FoundItem[] {
  const parsed = parseJson(text)
  const issues = isRecord(parsed) && Array.isArray(parsed.issues) ? parsed.issues : []
  return issues.flatMap((entry: unknown, i) => (isRecord(entry) ? issue(entry, ['issues', i], key) : []))
}

/** Comments of the issue the call names, linked once the workspace key is known. */
function listComments(id: string): ParseResult {
  return (text, key) => {
    const parsed = parseJson(text)
    const comments = isRecord(parsed) && Array.isArray(parsed.comments) ? parsed.comments : []
    return comments.flatMap((entry: unknown, i): FoundItem[] => {
      const comment = isRecord(entry) ? entry : {}
      const uuid = stringAt(comment, 'id') ?? ''
      if (!UUID.test(uuid) || typeof comment.body !== 'string') {
        return []
      }
      const time = isoTime(stringAt(comment, 'createdAt'))
      const ref = linearCommentRef(id, uuid)
      const permalink = key === null ? '' : `https://linear.app/${key}/issue/${id}#comment-${uuid.slice(0, 8)}`
      return [{ kind: 'linear', container: teamOf(id), ref, permalink, at: time, spans: [at(['comments', i, 'body'])] }]
    })
  }
}

/** Whether a call goes to a Linear tool server, whose answers may state the workspace key. */
export const isLinearCall = (call: ToolCall): boolean => call.mcp !== undefined && LINEAR.test(call.mcp.server)

/** The reader of a Linear MCP read's answer, or null for any other call. */
export function linearRead(call: ToolCall): ParseResult | null {
  if (call.mcp === undefined || !isLinearCall(call)) {
    return null
  }
  const tool = call.mcp.tool.split('__').at(-1) ?? call.mcp.tool
  const input = isRecord(call.input) ? call.input : {}
  if (tool === 'get_issue') {
    return getIssue(input.id)
  }
  if (tool === 'list_issues') {
    return listIssues
  }
  return tool === 'list_comments' && isLinearId(input.issueId) ? listComments(input.issueId) : null
}
