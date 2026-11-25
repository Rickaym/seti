/** The most of one edited field the agent is told; the rest is cut with a marker. */
export const NOTE_FIELD_CHARS = 2000

/** The most of all edited fields together the agent is told. */
export const NOTE_CHARS = 6000

/** The fields the user's edit changed, each with the value the user left in it. */
export type EditedValues = Readonly<Record<string, string>>

/** Each field as `name: "value"`, quoted as JSON so no value can end the list early. */
function fieldLines(values: EditedValues, cut: (more: number) => string): string {
  let left = NOTE_CHARS
  return Object.entries(values)
    .map(([name, value]) => {
      const shown = value.slice(0, Math.max(0, Math.min(NOTE_FIELD_CHARS, left)))
      left -= shown.length
      const more = value.length - shown.length
      const marker = more > 0 ? ` ${cut(more)}` : ''
      return `${JSON.stringify(name)}: ${JSON.stringify(shown)}${marker}`
    })
    .join('\n')
}

const ranCut = (more: number) => `[cut: ${String(more)} more characters; the full edited text is what was sent]`

const deniedCut = (more: number) => `[cut: ${String(more)} more characters of the user's text]`

/** What the agent is told about a call the user edited and then allowed; it ran with their text. */
export const editedRunNote = (values: EditedValues): string =>
  'The user edited this call in Seti before it ran, so it ran with their text in place of yours. ' +
  `The edited fields, as they ran:\n${fieldLines(values, ranCut)}`

/** The denial of a call the user edited first: their text for each field and any note they gave. */
export function editedDenial(values: EditedValues, message: string | null): string {
  const said =
    message === null || message === ''
      ? 'Do not retry it as you wrote it; ask the user how to go on if you need it.'
      : `The user said: ${message}`
  return (
    'The user edited this call in Seti and then denied it, so nothing ran. ' +
    `The user's text for the fields they edited:\n${fieldLines(values, deniedCut)}\n${said}`
  )
}
