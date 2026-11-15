import { HttpError } from './http.js'
import { scrubValue } from './scrub.js'

/** The longest input, as JSON, a request shows; a longer one is cut and cannot be edited. */
export const INPUT_CHARS = 8000

const isMcp = (tool: string) => tool.startsWith('mcp__')

const textFields = (input: Record<string, unknown>) =>
  Object.keys(input).filter((key) => typeof input[key] === 'string')

/**
 * Whether the user may edit the call before it runs: an MCP tool's call with text fields, shown
 * whole and with nothing redacted, so an edit never starts from a placeholder.
 */
export function isEditable(tool: string, input: Record<string, unknown>): boolean {
  const shown = JSON.stringify(input, null, 2)
  return (
    isMcp(tool) &&
    textFields(input).length > 0 &&
    shown.length <= INPUT_CHARS &&
    JSON.stringify(scrubValue(input), null, 2) === shown
  )
}

/** The names of the fields the user's values change. */
export const changedFields = (input: Record<string, unknown>, fields: Record<string, string>): string[] =>
  Object.keys(fields).filter((key) => input[key] !== fields[key])

/** The call's input with the user's values; each must replace a text field the call already has. */
export function withFields(input: Record<string, unknown>, fields: Record<string, string>): Record<string, unknown> {
  const text = new Set(textFields(input))
  const unknown = Object.keys(fields).filter((key) => !text.has(key))
  if (unknown.length > 0) {
    throw new HttpError(400, `Only the call's text fields can change, not ${unknown.join(', ')}`)
  }
  return { ...input, ...fields }
}
