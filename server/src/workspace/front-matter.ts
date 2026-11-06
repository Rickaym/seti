/** A front matter value: the small YAML subset workspace files use. */
type FrontValue = string | boolean | string[]

export type FrontMatter = Record<string, FrontValue>

export interface ParsedFile {
  front: FrontMatter
  body: string
}

const FENCE = '---'
const PLAIN = /^[\w@./:+* ,()-]*$/

function quote(value: string): string {
  const plain = value === value.trim() && PLAIN.test(value) && !/^(true|false|\[)/.test(value) && !value.includes(': ')
  return plain ? value : JSON.stringify(value)
}

function renderValue(value: FrontValue): string {
  if (typeof value === 'boolean') {
    return String(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item.includes(',') ? JSON.stringify(item) : quote(item))).join(', ')}]`
  }
  return quote(value)
}

export function renderFrontMatter(front: FrontMatter): string {
  const lines = Object.entries(front).map(([key, value]) => `${key}: ${renderValue(value)}`)
  return [FENCE, ...lines, FENCE].join('\n')
}

function parseScalar(raw: string): string {
  const text = raw.trim()
  if (text.startsWith('"')) {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'string') {
      throw new Error(`${text} is not a string`)
    }
    return parsed
  }
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) {
    return text.slice(1, -1).replace(/''/g, "'")
  }
  return text
}

function parseList(raw: string): string[] {
  const inner = raw.trim().slice(1, -1).trim()
  if (inner === '') {
    return []
  }
  const items: string[] = []
  let current = ''
  let quoted = false
  for (const char of inner) {
    if (char === '"' && !current.endsWith('\\')) {
      quoted = !quoted
    }
    if (char === ',' && !quoted) {
      items.push(current)
      current = ''
    } else {
      current += char
    }
  }
  return [...items, current].map(parseScalar).filter((item) => item !== '')
}

function parseValue(raw: string): FrontValue {
  const text = raw.trim()
  let value: FrontValue = parseScalar(text)
  if (text === 'true' || text === 'false') {
    value = text === 'true'
  } else if (text.startsWith('[')) {
    if (!text.endsWith(']')) {
      throw new Error(`the list ${text} has no closing ]`)
    }
    value = parseList(text)
  }
  return value
}

/** Splits front matter from the body; throws with a readable reason when it is malformed. */
export function parseFrontMatter(text: string): ParsedFile {
  const lines = text.split('\n')
  if (lines[0]?.trim() !== FENCE) {
    throw new Error('the file must start with a --- front matter line')
  }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === FENCE)
  if (end === -1) {
    throw new Error('the front matter has no closing --- line')
  }
  const front: FrontMatter = {}
  for (const line of lines.slice(1, end)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      continue
    }
    const colon = line.indexOf(':')
    if (colon <= 0) {
      throw new Error(`"${line.trim()}" is not a key: value line`)
    }
    const key = line.slice(0, colon).trim()
    if (!/^[a-z_]+$/.test(key)) {
      throw new Error(`"${key}" is not a front matter key`)
    }
    front[key] = parseValue(line.slice(colon + 1))
  }
  return { front, body: lines.slice(end + 1).join('\n') }
}

/** Reads one key as the given type; undefined when absent, throws when mistyped. */
export function frontString(front: FrontMatter, key: string): string | undefined {
  const value = front[key]
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'string') {
    throw new Error(`${key} must be text`)
  }
  return value
}

export function frontBoolean(front: FrontMatter, key: string): boolean | undefined {
  const value = front[key]
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'boolean') {
    throw new Error(`${key} must be true or false`)
  }
  return value
}
