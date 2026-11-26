/**
 * EA tools that act only on the user's own spoken or typed yes, given in the user turn right
 * after the EA read the change back; a notification Allow never covers them.
 */
export const EA_ON_WORD_TOOLS = ['answer_question'] as const
export type EaOnWordTool = (typeof EA_ON_WORD_TOOLS)[number]

export const isOnWordTool = (tool: string): tool is EaOnWordTool =>
  (EA_ON_WORD_TOOLS as readonly string[]).includes(tool)

/** The header that names the EA question whose confirmed yes covers the request. */
export const EA_ASK_HEADER = 'x-seti-ea-ask'

/** How long after the user's yes the EA may still use it. */
export const EA_WORD_USE_MS = 60_000

/** The longest tool call input the EA reads back whole; a longer one is allowed in Seti. */
export const EA_READ_BACK_CHARS = 600

/** A tool call's shown input on one line, as the EA reads it back. */
export const readBackText = (input: string): string => input.split(/\s+/).filter(Boolean).join(' ')

/**
 * Whether the EA can read the input back whole: it is not cut, which leaves it valid JSON, and it
 * fits the bound once on one line.
 */
export function readsBackWhole(input: string): boolean {
  try {
    JSON.parse(input)
  } catch {
    return false
  }
  return readBackText(input).length <= EA_READ_BACK_CHARS
}
