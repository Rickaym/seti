import { PLANNED_TITLE_MAX } from '@seti/shared'

const QUOTE_MARKS = new Set(['"', "'", '`'])

/** Drops quotes and spaces around a title, and a final period. */
function unquote(text: string): string {
  let start = 0
  let end = text.length
  while (start < end && (QUOTE_MARKS.has(text.charAt(start)) || text.charAt(start) === ' ')) {
    start += 1
  }
  while (end > start && (QUOTE_MARKS.has(text.charAt(end - 1)) || ' .'.includes(text.charAt(end - 1)))) {
    end -= 1
  }
  return text.slice(start, end)
}

/** Cuts at a word boundary so a clipped title never ends mid-word. */
function clip(text: string, max: number): string {
  if (text.length <= max) {
    return text
  }
  const cut = text.slice(0, max + 1)
  const space = cut.lastIndexOf(' ')
  return (space > max / 2 ? cut.slice(0, space) : text.slice(0, max)).trimEnd()
}

const upperFirst = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

/** A title from the message itself: its first line's opening words, the command sign dropped. */
export function fallbackTitle(message: string): string {
  const line =
    message
      .split('\n')
      .map((part) => part.replace(/^[/!#>*\-\s]+/, '').trim())
      .find((part) => part !== '') ?? ''
  const title = clip(unquote(line.replace(/\s+/g, ' ')), PLANNED_TITLE_MAX)
  return title === '' ? 'New agent' : upperFirst(title)
}

/** Stems of words that state an inability, an apology or a status rather than name work. */
const REPLY_STEMS = ['sorry', 'unable', 'cannot', 'cant', 'wont', 'apolog', 'suspend', 'refus', 'declin']

/** A title names the work, so it never speaks as the planner does. */
const FIRST_PERSON = new Set(['i', 'im', 'ive', 'me', 'my'])

const words = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/['\u2019]/g, '')
    .match(/[\p{L}\p{N}]+/gu) ?? []

/** Why a model title is not a name for the message's work, or null when it is one. */
export function titleProblem(title: string, message: string): string | null {
  if (title === '') {
    return 'The planner gave no title'
  }
  const said = words(message)
  const has = (stem: string) => said.some((word) => word.startsWith(stem))
  const own = words(title)
  const replies = own.some((word) => REPLY_STEMS.some((stem) => word.startsWith(stem) && !has(stem)))
  if (replies || own.some((word) => FIRST_PERSON.has(word) && !said.includes(word))) {
    return 'The planner answered the message instead of titling it'
  }
  return null
}

/** The model's title cleaned, or the message's opening words with the reason it was not used. */
export function titleFor(raw: string, message: string): { title: string; problem: string | null } {
  const title = clip(unquote(raw.replace(/\s+/g, ' ')), PLANNED_TITLE_MAX)
  const problem = titleProblem(title, message)
  return problem === null ? { title: upperFirst(title), problem } : { title: fallbackTitle(message), problem }
}
