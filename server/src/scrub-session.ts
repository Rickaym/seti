/** What every redacted value turns into. */
export const REDACTED = '[redacted]'

type Groups = Partial<Record<string, string>>

/** A rule over text whose replacer may keep a match, so findings ask it rather than the pattern. */
interface SessionRule {
  pattern: RegExp
  /** A cheap test that the text could hold a match at all, so long text skips the rule. */
  trigger: RegExp
  replace: (match: string, groups: Groups) => string
  kind: string
}

/** Names whose value is session material whatever it looks like. */
const STRONG_NAME = [
  String.raw`sb-[\w-]{1,80}-auth-token(?:[.-][\w-]{1,16})?`,
  String.raw`__(?:Secure|Host)-[\w.-]{1,80}`,
  String.raw`[\w.-]{0,40}session[-_.]?token`,
  String.raw`connect\.sid|phpsessid|jsessionid|asp\.net_sessionid`,
  String.raw`_[\w-]{1,40}_session`,
  String.raw`(?:provider_refresh|provider|access|refresh|id)_token`,
].join('|')
/** Names that hold a session only as a cookie or query value that looks generated; JSON ids pass. */
const WEAK_NAME = String.raw`session(?:[-_]?id)?|sessid|sid`
const NAME = `${STRONG_NAME}|${WEAK_NAME}`
const STRONG = new RegExp(`^(?:${STRONG_NAME})$`, 'i')
const WEAK = new RegExp(`^(?:${WEAK_NAME})$`, 'i')

const PLACEHOLDER = /^(?:\$|<|\{\{|%\(|\.\.\.|\*{3}|\[redacted\])/i
/** Identifiers, attribute paths and words, which code passes where a literal secret would go. */
const CODE_LIKE = [
  /^[A-Za-z_$][\w$]{0,30}(?:\.[A-Za-z_$][\w$]{0,30}){1,8}$/,
  /^(?:[a-z_]+|[A-Z_]+)$/,
  /^[a-z]+(?:[A-Z][a-z]+)+$/,
]
const COOKIE_ATTRIBUTE =
  /^(?:path|domain|expires|max-age|samesite|secure|httponly|priority|partitioned|version|comment)$/i
const TOKEN_CHARS = /^[\w.~+/%=-]+$/

const unquote = (value: string) => value.replace(/^\\{0,3}["'[{]?/, '')
const isCodeLike = (value: string) => CODE_LIKE.some((shape) => shape.test(value))

/** Whether a value is a placeholder, a variable or a redaction rather than a literal secret. */
const isPlaceholder = (value: string) => PLACEHOLDER.test(unquote(value)) || PLACEHOLDER.test(value)

/** A long generated value: base64 or hex-like, with lower and upper case letters and digits. */
const isTokenShaped = (value: string) =>
  value.length >= 32 && TOKEN_CHARS.test(value) && /[a-z]/.test(value) && /[A-Z]/.test(value) && /\d/.test(value)

/** Whether the named value is session material worth hiding. */
function isSessionValue(name: string, value: string): boolean {
  if (value.length < 4 || isPlaceholder(value) || isCodeLike(value) || /^[^{[]*\s/.test(value)) {
    return false
  }
  return STRONG.test(name) || (WEAK.test(name) && value.length >= 8 && /\d/.test(value))
}

/** A cookie list with each value redacted and each name and attribute kept. */
/** A cookie value worth hiding: under a session name, or long and generated like a token. */
const isCookieSecret = (name: string, value: string) =>
  !COOKIE_ATTRIBUTE.test(name) &&
  !isPlaceholder(value) &&
  (isSessionValue(name, value) || (value.length >= 16 && /\d/.test(value) && /[A-Za-z]/.test(value)))

/** A cookie list with each secret value redacted and every name, attribute and short value kept. */
function redactCookiePairs(text: string): string {
  return text.replace(
    /(^|[;\s])([^\s=;,]{1,256})=([^;\s]{1,8192})/g,
    (pair: string, lead: string, name: string, value: string) =>
      isCookieSecret(name, value) ? `${lead}${name}=${REDACTED}` : pair,
  )
}

/** An authorization value with its scheme kept and its credential redacted. */
function redactAuthorization(value: string): string {
  const scheme = /^([A-Za-z][\w-]{0,30}[ \t]{1,4})(\S.*)$/s.exec(value)
  const credential = scheme?.[2] ?? value
  if (isPlaceholder(credential) || credential.length < 8 || /^[\w-]+=$|\(/.test(credential) || isCodeLike(credential)) {
    return value
  }
  if (scheme === null) {
    return credential.length >= 16 && /\d/.test(credential) ? REDACTED : value
  }
  return `${scheme[1] ?? ''}${REDACTED}`
}

const b64Text = (blob: string) =>
  Buffer.from(blob.slice(0, 160).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('latin1')
const SESSION_KEY = /"(?:access_token|refresh_token|provider_token|id_token|session|token|secret|password)"/

/** Base64 of a JSON object that holds tokens, such as a Supabase `base64-` session cookie. */
const isSessionBlob = (blob: string) => SESSION_KEY.test(b64Text(blob))

/** A value that is a session either by its name or by its shape. */
const storedValueIsSession = (name: string, value: string) =>
  isSessionValue(name, value) ||
  (!isPlaceholder(value) && (isTokenShaped(value) || /access_token|refresh_token/.test(value)))

const QUOTED = String.raw`"(?:[^"\\\r\n]|\\.){0,20000}"|'(?:[^'\\\r\n]|\\.){0,20000}'`
const PAIR_VALUE = [
  String.raw`"(?:[^"\\\r\n]|\\.){0,8192}"`,
  String.raw`[[{](?="|\\")[^;\r\n]{0,8192}`,
  String.raw`[^\s;&"'<>,()[\]{}\\\x60]{1,8192}(?![\w(])`,
].join('|')
/** The end of a header label in raw HTTP, JSON, a dict or an object: quotes, a colon or `=`. */
const LABEL_END = String.raw`\\{0,3}["']?[ \t]{0,8}[:=][ \t]{0,8}\\{0,3}["'\x60]?`

const keepIf = (keep: boolean, match: string, redacted: string) => (keep ? match : redacted)
const unwrap = (value: string) => value.slice(1, -1)
const rewrap = (value: string) => `${value.charAt(0)}${REDACTED}${value.charAt(0)}`
const SECRET_HEADER = /token|key|secret|session|signature|password|auth/i
const NAMED_HEADER = /^(?:(?:proxy-)?authorization|(?:set-)?cookie)$/i
const NAME_TRIGGER = /sess|sid|_token|sb-|__secure|__host/i

/** Session material by its shape and by the names that carry it; each keeps names, hides values. */
const SESSION_RULES: SessionRule[] = [
  {
    kind: 'authorization header',
    trigger: /authorization/i,
    pattern: new RegExp(
      String.raw`(?<![\w-])(?<label>(?:proxy-)?authorization${LABEL_END})(?<value>(?:[A-Za-z][\w-]{0,30}[ \t]{1,4})?[^\s"'\x60\\,;}]{1,8192})`,
      'gi',
    ),
    replace: (_match, { label = '', value = '' }) => `${label}${redactAuthorization(value)}`,
  },
  {
    kind: 'bearer token',
    trigger: /bearer/i,
    pattern: /(?<![\w-])(?<label>bearer[ \t]{1,4})(?<value>[\w.~+/-]{16,4096}=*)/gi,
    replace: (match, { label = '', value = '' }) => keepIf(!/\d/.test(value), match, `${label}${REDACTED}`),
  },
  {
    kind: 'cookie',
    trigger: /cookie/i,
    pattern: new RegExp(
      String.raw`(?<![\w-])(?<label>(?:set-)?cookie${LABEL_END})(?<pairs>[^\r\n"'\x60\\]{1,8192})`,
      'gi',
    ),
    replace: (_match, { label = '', pairs = '' }) => `${label}${redactCookiePairs(pairs)}`,
  },
  {
    kind: 'cookie',
    trigger: /-b|--cookie/,
    pattern:
      /(?<![\w-])(?<flag>(?:-b|--cookie)(?:[ \t]{1,8}|=))(?:(?<quote>["'])(?<quoted>[^\r\n"'\\]{1,8192})\k<quote>|(?<bare>[^\s"'\\]{1,8192}))/g,
    replace: (_match, { flag = '', quote = '', quoted, bare = '' }) =>
      `${flag}${quote}${redactCookiePairs(quoted ?? bare)}${quote}`,
  },
  {
    kind: 'cookie',
    trigger: /document\.cookie/,
    pattern:
      /(?<label>document\.cookie\b[^\r\n]{0,40}?(?:=>|->|[=:\n])\s{0,8}["'\x60])(?<pairs>[^\r\n"'\x60]{1,8192})/g,
    replace: (_match, { label = '', pairs = '' }) => `${label}${redactCookiePairs(pairs)}`,
  },
  {
    kind: 'browser storage',
    trigger: /value/,
    pattern: new RegExp(
      String.raw`(?<head>(?<![\w-])(?<key>["']?)name\k<key>\s{0,8}:\s{0,8}(?<quote>["'])(?<name>[^"'\\\r\n]{1,256})\k<quote>\s{0,8},\s{0,40}(?<valueKey>["']?)value\k<valueKey>\s{0,8}:\s{0,8})(?<value>${QUOTED})`,
      'g',
    ),
    replace: (match, { head = '', name = '', value = '' }) =>
      keepIf(!storedValueIsSession(name, unwrap(value)), match, `${head}${rewrap(value)}`),
  },
  {
    kind: 'session token',
    trigger: NAME_TRIGGER,
    pattern: new RegExp(
      String.raw`(?<![\w.%-])(?<head>(?<quote>["']?)(?<name>${STRONG_NAME})\k<quote>\s{0,8}[:=]\s{0,8})(?<value>${QUOTED})`,
      'gi',
    ),
    replace: (match, { head = '', name = '', value = '' }) =>
      keepIf(!isSessionValue(name, unwrap(value)), match, `${head}${rewrap(value)}`),
  },
  {
    kind: 'session token',
    trigger: NAME_TRIGGER,
    pattern: new RegExp(
      String.raw`(?<![\w.%-])(?<head>\\{1,3}"(?<name>${STRONG_NAME})\\{1,3}"\s{0,8}:\s{0,8}\\{1,3}")(?<value>[^"\\\s]{1,8192})`,
      'gi',
    ),
    replace: (match, { head = '', name = '', value = '' }) =>
      keepIf(!isSessionValue(name, value), match, `${head}${REDACTED}`),
  },
  {
    kind: 'session token',
    trigger: NAME_TRIGGER,
    pattern: new RegExp(String.raw`(?<![\w.%-])(?<name>${NAME})=(?<value>${PAIR_VALUE})`, 'gi'),
    replace: (match, { name = '', value = '' }) =>
      keepIf(!isSessionValue(name, value.replace(/^"|"$/g, '')), match, `${name}=${REDACTED}`),
  },
  {
    kind: 'session token',
    trigger: /eyJ/,
    pattern: /(?<![A-Za-z0-9+/])(?<prefix>base64-)?(?<blob>eyJ[A-Za-z0-9+/_-]{16,20000}={0,2})/g,
    replace: (match, { prefix = '', blob = '' }) => keepIf(!isSessionBlob(blob), match, `${prefix}${REDACTED}`),
  },
  {
    kind: 'header secret',
    trigger: /-H|--header/,
    pattern:
      /(?<![\w-])(?<head>(?:-H|--header)(?:[ \t]{1,8}|=)(?<quote>["'])(?<name>[\w-]{1,64})[ \t]{0,4}:[ \t]{0,8})(?<value>[^"'\r\n]{8,8192})(?=\k<quote>)/g,
    replace: (match, { head = '', name = '', value = '' }) =>
      keepIf(!SECRET_HEADER.test(name) || NAMED_HEADER.test(name) || isPlaceholder(value), match, `${head}${REDACTED}`),
  },
  {
    kind: 'netrc password',
    trigger: /password/,
    pattern: new RegExp(
      String.raw`(?<head>(?:\bmachine[ \t]{1,8}(?:[\w-]{1,63}\.[\w.-]{1,253}|localhost)|^[ \t]*default)(?:\s{1,40}(?:login|account)[ \t]{1,8}\S{1,256}){0,2}\s{1,40}password[ \t]{1,8})(?<value>\S{1,1024})`,
      'gm',
    ),
    replace: (match, { head = '', value = '' }) => keepIf(isPlaceholder(value), match, `${head}${REDACTED}`),
  },
]

const replaced = (rule: SessionRule, match: RegExpExecArray) => rule.replace(match[0], match.groups ?? {})

/** The text with one rule applied to each of its matches. */
function applyRule(text: string, rule: SessionRule): string {
  if (!rule.trigger.test(text)) {
    return text
  }
  let out = ''
  let last = 0
  for (const match of text.matchAll(rule.pattern)) {
    out += text.slice(last, match.index) + replaced(rule, match)
    last = match.index + match[0].length
  }
  return last === 0 ? text : out + text.slice(last)
}

/** The text with every session rule applied; each skips text without its trigger. */
export const redactSessions = (text: string): string => SESSION_RULES.reduce(applyRule, text)

/** Where a session rule would redact, by index and kind, for the share and knowledge scans. */
export function sessionFindings(text: string): { index: number; kind: string }[] {
  return SESSION_RULES.flatMap((rule) =>
    rule.trigger.test(text)
      ? [...text.matchAll(rule.pattern)]
          .filter((match) => replaced(rule, match) !== match[0])
          .map((match) => ({ index: match.index, kind: rule.kind }))
      : [],
  )
}

const COOKIE_KEY = /^(?:set-)?cookie$/i
const AUTH_KEY = /^(?:proxy-)?authorization$/i

/** A JSON field's string as its key says to read it: a cookie list, an authorization or a session. */
export function scrubField(key: string, value: string): string {
  if (COOKIE_KEY.test(key)) {
    return redactCookiePairs(value)
  }
  if (AUTH_KEY.test(key)) {
    return redactAuthorization(value)
  }
  return STRONG.test(key) && isSessionValue(key, value) ? REDACTED : value
}

/** A `{ name, value }` entry of browser storage state, its value hidden when a session. */
export function scrubStoragePair(entry: object): object {
  if (!('name' in entry) || !('value' in entry)) {
    return entry
  }
  const { name, value } = entry
  if (typeof name !== 'string' || typeof value !== 'string' || !storedValueIsSession(name, value)) {
    return entry
  }
  return { ...entry, value: REDACTED }
}
