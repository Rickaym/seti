/** A content block of an assistant message, as far as the question detector reads it. */
export interface TurnBlock {
  type: string
  text?: string | undefined
  name?: string | undefined
}

/** What the closing prose of a reply asks the user. */
export interface ProseQuestion {
  asks: boolean
  /** The question on one line with its Markdown removed; empty when nothing is asked. */
  question: string
  /** The answers the reply listed for it, at most four; empty when it listed none. */
  options: string[]
  /** Whether yes or no answers it; false for one that asks which, what or how. */
  closed: boolean
}

/** The most answers a question offers as quick replies. */
const OPTIONS_MAX = 4

const QUESTION_MAX = 200
/** A longer list is a report or a plan, not a set of answers to pick from. */
const LIST_MAX = 8

const NOTHING: ProseQuestion = { asks: false, question: '', options: [], closed: false }

type Segment =
  { kind: 'prose'; lines: string[] } | { kind: 'list'; ordered: boolean; items: string[] } | { kind: 'other' }

const FENCE = /^ {0,3}(`{3,}|~{3,})/
const ITEM = /^\s{0,5}(?:(\d{1,2}|[A-Za-z])[.)]|[-*+])\s+(\S.*)$/
/** Lines that are neither prose nor answers: quotes, headings, table rows and rules. */
const OTHER = /^\s{0,3}(?:>|#{1,6}\s|\||(?:[-*_]\s*){3,}$)/
const CONTINUES = /^\s{2,}\S/

/** The lines outside fenced code blocks; an unclosed fence runs to the end. */
function proseLines(text: string): string[] {
  const kept: string[] = []
  let fence: string | null = null
  for (const line of text.split('\n')) {
    const marker = FENCE.exec(line)?.[1]
    if (fence === null && marker !== undefined) {
      fence = marker
      kept.push('')
    } else if (fence !== null && marker?.startsWith(fence.charAt(0)) === true && marker.length >= fence.length) {
      fence = null
    } else if (fence === null) {
      kept.push(line)
    }
  }
  return kept
}

function addItem(segments: Segment[], marker: string | undefined, text: string): void {
  const last = segments.at(-1)
  if (last?.kind === 'list') {
    last.items.push(text)
  } else {
    segments.push({ kind: 'list', ordered: marker !== undefined, items: [text] })
  }
}

/** A line of words: more of the list item or paragraph above it, or a new paragraph. */
function addWords(segments: Segment[], line: string, gap: boolean): void {
  const last = segments.at(-1)
  if (last?.kind === 'list' && !gap && CONTINUES.test(line)) {
    last.items[last.items.length - 1] = `${last.items.at(-1) ?? ''} ${line.trim()}`
  } else if (last?.kind === 'prose' && !gap) {
    last.lines.push(line.trim())
  } else {
    segments.push({ kind: 'prose', lines: [line.trim()] })
  }
}

function addLine(segments: Segment[], line: string, gap: boolean): void {
  const item = ITEM.exec(line)
  if (OTHER.test(line)) {
    segments.push({ kind: 'other' })
  } else if (item === null) {
    addWords(segments, line, gap)
  } else {
    addItem(segments, item[1], item[2] ?? '')
  }
}

/** The text as paragraphs, lists and everything else, in order; a blank line ends a paragraph. */
function segmentsOf(text: string): Segment[] {
  const segments: Segment[] = []
  let gap = false
  for (const line of proseLines(text)) {
    if (line.trim() === '') {
      gap = true
    } else {
      addLine(segments, line, gap)
      gap = false
    }
  }
  return segments
}

/** One line of plain words: links read as their text and emphasis marks are dropped. */
function plain(text: string): string {
  return text
    .replace(/\[([^[\]]+)\]\([^()]*\)/g, '$1')
    .replace(/[*`~]+/g, '')
    .replace(/(?<![A-Za-z0-9])_+|_+(?![A-Za-z0-9])/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Inline code blanked out at the same length, so a question mark inside it never counts. */
const maskCode = (text: string) => text.replace(/`[^`]*`/g, (code) => `\`${'x'.repeat(code.length - 2)}\``)

const CLOSERS = new Set([' ', '*', '_', ')', ']', '~'])
const QUOTES = new Set(['"', "'"])

function withoutClosers(text: string): string {
  let end = text.length
  while (end > 0 && CLOSERS.has(text.charAt(end - 1))) {
    end -= 1
  }
  return text.slice(0, end)
}

/** Whether the sentence ends on a question mark of its own, not one inside quotes. */
const isQuestion = (masked: string) => withoutClosers(masked).endsWith('?')

const endsQuoted = (masked: string) => QUOTES.has(withoutClosers(masked).at(-1) ?? '')

const ABBREVIATION = /\b(?:e\.g|i\.e|etc|vs)\.$/i
const SENTENCE_END = /[.!?]["')\]*_]*\s+(?=[A-Z0-9"'([*_`])/g

/** The paragraph's sentences as they read, each beside its form with inline code blanked. */
function sentences(raw: string): { text: string; masked: string }[] {
  const masked = maskCode(raw)
  const cuts = [...masked.matchAll(SENTENCE_END)]
    .filter((match) => !ABBREVIATION.test(masked.slice(0, match.index + 1)))
    .map((match) => match.index + match[0].length)
  const bounds = [0, ...cuts, masked.length]
  return bounds.slice(1).map((end, index) => {
    const start = bounds[index] ?? 0
    return { text: raw.slice(start, end), masked: masked.slice(start, end) }
  })
}

/** A sentence in lower case without punctuation, as the phrase lists below match it. */
const words = (sentence: string) =>
  plain(sentence)
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:(?:and|or|so|but|then|also|ok|okay|alright) )+/, '')

/** Closing courtesies that end a finished turn and need no answer. */
const SIGN_OFFS = [
  /^(?:is there |do you need |need )?anything else(?: here| for now| today)?$/,
  /^(?:is there )?anything else (?:i|we) (?:can|could|should) (?:help|do|check|change|add)(?: you)?(?: with)?$/,
  /^(?:is there )?anything else you need$/,
  /^(?:is there )?anything else you(?:'d| would) like(?: me to (?:do|change|add|check))?$/,
  /^(?:can|could|may) i help(?: you)?(?: with)? anything else$/,
  /^(?:does|did) (?:that|this|it) (?:all )?(?:make sense|help)$/,
  /^(?:does|did) (?:that|this|it) (?:answer (?:your|the) question|clear (?:it|things) up)$/,
  /^make sense$/,
  /^(?:do you have )?(?:any )?(?:other |more |further )?questions$/,
  /^what(?:'s| is)? next$/,
  /^what (?:would you like|do you want)(?: me)? to (?:do|work on|tackle|look at) next$/,
  /^what should (?:i|we) (?:do|work on|tackle|look at) next$/,
]

/** Openers of a question the agent puts to itself. */
const MUSING = /^(?:why|how come|i wonder|wondering|who knows)\b/
const SECOND_PERSON = /\byou(?:r|rs)?\b/
const OPEN = /^(?:which|what|who|whom|whose|where|when|how|why)\b/
/** Words that put a question to the user, when the list under it could be the agent's answer. */
const ASKS_USER = /\b(?:you|your|(?:should|shall|can|could|may|do|must) (?:i|we)|want me|like me)\b/
const PICKS = /\b(?:options?|choose|pick|prefer|either|go with)\b/
const CHOICE = /\b(?:which|options?|choices?|choose|pick|prefer|preference|either|alternatives?|one of|go with)\b/
const OFFERS = /\b(?:options?|choices?|alternatives?|either|approach(?:es)?|ways)\b/

const needsAnswer = (sentence: string) => {
  const said = words(sentence)
  return !SIGN_OFFS.some((phrase) => phrase.test(said)) && !(MUSING.test(said) && !SECOND_PERSON.test(said))
}

const tidy = (sentence: string) => {
  const text = plain(sentence)
  return text.startsWith('(') && text.endsWith(')') ? text.slice(1, -1).trim() : text
}

const clipped = (text: string) =>
  text.length > QUESTION_MAX ? `${text.slice(0, QUESTION_MAX - 3).trimEnd()}...` : text

interface Asked {
  question: string
  closed: boolean
}

/** The questions a paragraph ends with, at most the last two; null when it ends otherwise. */
function askedIn(lines: readonly string[]): Asked | null {
  const all = sentences(lines.join(' '))
  if (endsQuoted(all.at(-1)?.masked ?? '')) {
    return null
  }
  const run = all.slice(all.findLastIndex((sentence) => !isQuestion(sentence.masked)) + 1)
  const asked = run.filter((sentence) => needsAnswer(sentence.text)).slice(-2)
  const last = asked.at(-1)
  if (last === undefined) {
    return null
  }
  return {
    question: clipped(asked.map((sentence) => tidy(sentence.text)).join(' ')),
    closed: !OPEN.test(words(last.text)),
  }
}

const optionsOf = (items: readonly string[]) => items.slice(0, OPTIONS_MAX).map(plain)

/** A reply that ends with a question and then the list it is about. */
function listAfterQuestion(asked: Asked, list: Extract<Segment, { kind: 'list' }>): ProseQuestion {
  const said = asked.question.toLowerCase()
  if (!ASKS_USER.test(said) && !PICKS.test(said)) {
    return NOTHING
  }
  const offered = list.items.length >= 2 && list.items.length <= LIST_MAX && (list.ordered || CHOICE.test(said))
  return { asks: true, ...asked, options: offered ? optionsOf(list.items) : [] }
}

/** A reply that ends with a list whose items are themselves the questions. */
function listOfQuestions(items: readonly string[], lead: Segment | undefined): ProseQuestion {
  const asking = items.filter((item) => isQuestion(maskCode(item)) && !endsQuoted(maskCode(item)))
  const last = items.at(-1) ?? ''
  if (asking.at(-1) !== last || !needsAnswer(last)) {
    return NOTHING
  }
  const every = asking.length === items.length && items.length >= 2 && items.length <= LIST_MAX
  const intro = lead?.kind === 'prose' ? tidy(lead.lines.join(' ')).replace(/:$/, '') : ''
  return {
    asks: true,
    question: clipped(every && intro !== '' ? intro : tidy(last)),
    options: every ? optionsOf(items) : [],
    closed: !every && !OPEN.test(words(last)),
  }
}

function endingWithList(segments: readonly Segment[], list: Extract<Segment, { kind: 'list' }>): ProseQuestion {
  const before = segments.at(-2)
  const asked = before?.kind === 'prose' ? askedIn(before.lines) : null
  return asked === null ? listOfQuestions(list.items, before) : listAfterQuestion(asked, list)
}

/** The answers a list right before the closing question offers, when it reads as a choice. */
function optionsBefore(segments: readonly Segment[], question: string): string[] {
  const list = segments.at(-2)
  if (list?.kind !== 'list' || list.items.length < 2 || list.items.length > LIST_MAX) {
    return []
  }
  const lead = segments.at(-3)
  const intro = lead?.kind === 'prose' ? lead.lines.join(' ').toLowerCase() : ''
  return CHOICE.test(question.toLowerCase()) || OFFERS.test(intro) ? optionsOf(list.items) : []
}

/**
 * What a reply's prose asks the user, read without a model. It asks when its last paragraph
 * outside fenced code ends with a question, or when a question and a list of answers end it
 * together. A question in quotes, a quote block, a heading or code does not count, nor one the
 * reply goes on to answer, one the agent puts to itself, or a closing courtesy such as
 * "Anything else?".
 */
export function proseQuestion(text: string): ProseQuestion {
  const segments = segmentsOf(text)
  const last = segments.at(-1)
  if (last?.kind === 'list') {
    return endingWithList(segments, last)
  }
  const asked = last?.kind === 'prose' ? askedIn(last.lines) : null
  return asked === null ? NOTHING : { asks: true, ...asked, options: optionsBefore(segments, asked.question) }
}

/**
 * What a turn ends by asking the user in prose: the question in the text it wrote after its last
 * tool use. AskUserQuestion calls wait as questions instead. Blocks come oldest first.
 */
export function closingQuestion(blocks: readonly TurnBlock[]): ProseQuestion {
  const lastTool = blocks.findLastIndex((block) => block.type === 'tool_use')
  const closing = blocks
    .slice(lastTool + 1)
    .flatMap((block) => (block.type === 'text' && block.text !== undefined ? [block.text] : []))
  return proseQuestion(closing.join('\n\n'))
}
