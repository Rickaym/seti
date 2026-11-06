import type { AuditDetail } from '@seti/shared'

export const MAX_SUMMARY = 300
const MAX_DETAIL_TEXT = 500
/** Detail fields named as long keep their line breaks up to this length. */
export const MAX_LONG_DETAIL_TEXT = 4000
const REDACTED = '[redacted]'

const SECRET_WORD = String.raw`(?:password|passwd|secret|token|credentials?|api[_-]?key|apikey|access[_-]?key|private[_-]?key|key)`
const VALUE = String.raw`("[^"]*"|'[^']*'|[^\s&"',;]+)`

/** Bounded repeats keep every rule linear, even on megabytes of dotted or minified text. */
const RULES: [RegExp, string][] = [
  [/\b((?:proxy-)?authorization\s*[:=]\s*)[^\r\n"']+/gi, `$1${REDACTED}`],
  [/\b(bearer)\s+[\w.~+/=-]{6,}/gi, `$1 ${REDACTED}`],
  [/(\b[a-z][\w+.-]{0,30}:\/\/)[^\s/@:]{1,256}(?::[^\s/@]{0,256})?@/gi, `$1${REDACTED}@`],
  [/\b(?:gh[pousr]_|github_pat_|sk-|[sr]k_live_|xox[abeoprs]-|xapp-|glpat-|fak_|cfat_|whsec_)[\w-]{8,}/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  [/\beyJ[\w-]{8,4096}\.[\w-]{8,4096}\.[\w-]{8,4096}/g, REDACTED],
  [new RegExp(String.raw`([\w.-]{0,64}${SECRET_WORD}["']?)(\s{0,8}[=:]\s{0,8})${VALUE}`, 'gi'), `$1$2${REDACTED}`],
  [new RegExp(String.raw`(\s--?[\w-]{0,64}${SECRET_WORD})(\s{1,8})${VALUE}`, 'gi'), `$1$2${REDACTED}`],
]

interface CredentialRule {
  pattern: RegExp
  replacement: string
  /** What the secret scan of a share calls a match. */
  kind: string
}

/** Credentials recognisable by their shape alone, so code, diffs and prose pass through intact. */
const CREDENTIAL_RULES: CredentialRule[] = [
  {
    pattern: /-----BEGIN ([A-Z ]{0,40}PRIVATE KEY)-----[A-Za-z0-9+/=\s]+-----END [A-Z ]{0,40}PRIVATE KEY-----/g,
    replacement: `-----BEGIN $1-----\n${REDACTED}\n-----END $1-----`,
    kind: 'private key',
  },
  {
    pattern: /\b(?:gh[pousr]_|github_pat_|sk-|[sr]k_live_|xox[abeoprs]-|xapp-|glpat-|fak_|cfat_|npm_|whsec_)[\w-]{8,}/g,
    replacement: REDACTED,
    kind: 'access token',
  },
  { pattern: /\bsk_[a-f0-9]{32,}\b/g, replacement: REDACTED, kind: 'secret key' },
  { pattern: /\bAIza[\w-]{35}\b/g, replacement: REDACTED, kind: 'Google API key' },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: REDACTED, kind: 'AWS access key' },
  { pattern: /\beyJ[\w-]{8,4096}\.[\w-]{8,4096}\.[\w-]{8,4096}/g, replacement: REDACTED, kind: 'JWT' },
  {
    pattern: /(\b[a-z][\w+.-]{0,30}:\/\/[^\s/@:]{1,256}:)[^\s/@$<{][^\s/@]{0,256}@/gi,
    replacement: `$1${REDACTED}@`,
    kind: 'password in a URL',
  },
  {
    pattern: /\b((?:proxy-)?authorization\s*:\s*(?:bearer|basic|token)\s+)[\w.~+/=-]{16,}/gi,
    replacement: `$1${REDACTED}`,
    kind: 'authorization header',
  },
]

const ENV_LINE = /^([ \t]*(?:export[ \t]+)?)([A-Z][A-Z0-9_]*)=("[^"\n]*"|'[^'\n]*'|[^\s#]+)/gm
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSW(?:OR)?D|CREDENTIAL/
const PLACEHOLDER = /^["']?[$<{/~.]/
const ENV_VALUE_MIN = 8

const isSecretEnv = (name: string, value: string) =>
  SECRET_NAME.test(name) && value.length >= ENV_VALUE_MIN && !PLACEHOLDER.test(value)

/** `NAME=value` lines of env files and shell exports whose name says the value is a secret. */
function redactEnvLines(text: string): string {
  return text.replace(ENV_LINE, (line: string, lead: string, name: string, value: string) =>
    isSecretEnv(name, value) ? `${lead}${name}=${REDACTED}` : line,
  )
}

/** Redacts only unmistakable credentials; used on transcripts, where code must stay readable. */
export function redactCredentials(text: string): string {
  const shaped = CREDENTIAL_RULES.reduce((out, rule) => out.replace(rule.pattern, rule.replacement), text)
  return redactEnvLines(shaped)
}

/** A credential redactCredentials would hide, by its 1-based line and kind, never its value. */
export interface CredentialFinding {
  line: number
  kind: string
}

/** A private key's first line flags a key cut short, which the full-block rule misses. */
const KEY_HEADER = { pattern: /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----/g, kind: 'private key' }

/** Where redactCredentials would redact, one finding per line and kind, in line order. */
export function credentialFindings(text: string): CredentialFinding[] {
  const starts = [0]
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) {
    starts.push(at + 1)
  }
  const lineOf = (index: number) => {
    let low = 0
    let high = starts.length - 1
    while (low < high) {
      const mid = Math.ceil((low + high) / 2)
      if ((starts[mid] ?? 0) <= index) {
        low = mid
      } else {
        high = mid - 1
      }
    }
    return low + 1
  }
  const found = new Map<string, CredentialFinding>()
  const add = (index: number, kind: string) => {
    const line = lineOf(index)
    found.set(`${String(line)} ${kind}`, { line, kind })
  }
  for (const rule of [...CREDENTIAL_RULES, KEY_HEADER]) {
    for (const match of text.matchAll(rule.pattern)) {
      add(match.index, rule.kind)
    }
  }
  for (const match of text.matchAll(ENV_LINE)) {
    if (isSecretEnv(match[2] ?? '', match[3] ?? '')) {
      add(match.index, 'secret in an env line')
    }
  }
  return [...found.values()].sort((a, b) => (a.line === b.line ? a.kind.localeCompare(b.kind, 'en') : a.line - b.line))
}

/** Redacts values that look like credentials, leaving the surrounding text readable. */
export function redactSecrets(text: string): string {
  return RULES.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), redactCredentials(text))
}

const isBase64Source = (value: object) => 'type' in value && value.type === 'base64'

function scrubJson(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactCredentials(value)
  }
  if (Array.isArray(value)) {
    const next = value.map(scrubJson)
    return next.some((item, index) => item !== value[index]) ? next : value
  }
  if (typeof value === 'object' && value !== null && !isBase64Source(value)) {
    const entries = Object.entries(value)
    const next = entries.map(([key, item]) => [key, scrubJson(item)] as const)
    return next.some(([, item], index) => item !== entries[index]?.[1]) ? Object.fromEntries(next) : value
  }
  return value
}

/** Redacts credentials in every string of a JSON value; unchanged parts keep their reference. */
export const scrubValue = <T>(value: T): T => scrubJson(value) as T

const SECRET_FIELD =
  /password|passwd|secret|token|credential|api[_-]?key|apikey|access[_-]?key|private[_-]?key|authorization/i

/** A tool input with secret-named string fields blanked and secret-looking text redacted. */
export function scrubInput(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactSecrets(value)
  }
  if (Array.isArray(value)) {
    return value.map(scrubInput)
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        typeof item === 'string' && SECRET_FIELD.test(key) ? REDACTED : scrubInput(item),
      ]),
    )
  }
  return value
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text
}

/** One line, secrets redacted, at most MAX_SUMMARY characters. */
export const scrubSummary = (text: string, max = MAX_SUMMARY) =>
  clip(redactSecrets(text).replace(/\s+/g, ' ').trim(), max)

const scrubText = (text: string) => scrubSummary(text, MAX_DETAIL_TEXT)

/** Scrubs every detail value; `long` names text fields kept multi-line up to MAX_LONG_DETAIL_TEXT. */
export function scrubDetail(detail: AuditDetail, long: readonly string[] = []): AuditDetail {
  const out: AuditDetail = {}
  for (const [key, value] of Object.entries(detail)) {
    if (typeof value === 'string' && long.includes(key)) {
      out[key] = clip(redactCredentials(value), MAX_LONG_DETAIL_TEXT)
    } else if (typeof value === 'string') {
      out[key] = scrubText(value)
    } else {
      out[key] = Array.isArray(value) ? value.map(scrubText) : value
    }
  }
  return out
}
