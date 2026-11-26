import type { ToolCall } from '@seti/shared'
import { at, isoTime, isRecord, parseJson, stringAt, type FoundItem, type ParseResult } from './item.js'
import { isLinearId, linearCommentRef, linearRef } from './refs.js'

const LINEAR = /linear/i
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** The team key of an identifier such as `ENG-12`. */
const teamOf = (id: string) => id.slice(0, id.indexOf('-'))

/** The issue's own URL, kept only when it names the same identifier on linear.app. */
function issueUrl(record: Record<string, unknown>, id: string): string {
  const url = stringAt(record, 'url') ?? ''
  const pattern = new RegExp(`^https://linear\\.app/[\\w-]+/issue/${id}(?:/[\\w-]*)?$`)
  return pattern.test(url) ? url : ''
}

/** An issue as a get or a list states it: its identifier, its URL, and its title and description. */
function issue(record: Record<string, unknown>, path: readonly (string | number)[]): FoundItem[] {
  const id = record.id
  if (!isLinearId(id)) {
    return []
  }
  const spans = ['title', 'description'].flatMap((key) => (typeof record[key] === 'string' ? [at([...path, key])] : []))
  const time = isoTime(stringAt(record, 'createdAt'))
  return spans.length === 0
    ? []
    : [{ kind: 'linear', container: teamOf(id), ref: linearRef(id), permalink: issueUrl(record, id), at: time, spans }]
}

/** The issue a get answers with, when it is the one the call asked for by identifier. */
function getIssue(asked: unknown): ParseResult {
  return (text) => {
    const parsed = parseJson(text)
    const fits = isRecord(parsed) && (!isLinearId(asked) || parsed.id === asked)
    return fits ? issue(parsed, []) : []
  }
}

function listIssues(text: string): FoundItem[] {
  const parsed = parseJson(text)
  const issues = isRecord(parsed) && Array.isArray(parsed.issues) ? parsed.issues : []
  return issues.flatMap((entry: unknown, i) => (isRecord(entry) ? issue(entry, ['issues', i]) : []))
}

/** Comments of the issue the call names; a comment's permalink is left empty, its id is kept. */
function listComments(id: string): ParseResult {
  return (text) => {
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
      return [
        { kind: 'linear', container: teamOf(id), ref, permalink: '', at: time, spans: [at(['comments', i, 'body'])] },
      ]
    })
  }
}

/** The reader of a Linear MCP read's answer, or null for any other call. */
export function linearRead(call: ToolCall): ParseResult | null {
  if (call.mcp === undefined || !LINEAR.test(call.mcp.server)) {
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
