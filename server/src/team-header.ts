const DATE = String.raw`\d{4}-\d{2}-\d{2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?[ \t]*(?:Z|UTC)?)?`
const WHEN = String.raw`(?:,[ \t]*|[ \t]+[-\u2013\u2014][ \t]+)${DATE}`

/**
 * A regex source, read alike by JavaScript and Postgres, for the heading lines that open a post
 * by `name` and name only its author, like `### 12 @name (you), 2026-10-14 05:24Z`, with the
 * blank lines around them. A line needs leading #s or a date, so a bare `@name` is kept.
 */
export function selfHeaderPattern(name: string): string {
  const who = String.raw`(?:\d+[ \t]+)?@?${name}(?:[ \t]+\(you\))?`
  const line = String.raw`[ \t]*(?:#+[ \t]*${who}(?:${WHEN})?|${who}${WHEN})[ \t]*(?:\r?\n|$)`
  return String.raw`^(?:[ \t]*\r?\n)*(?:${line}(?:[ \t]*\r?\n)*)+`
}

/** The post without the headings that name its own author, as Seti adds its own; never empty. */
export function stripSelfHeader(text: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const stripped = text.replace(new RegExp(selfHeaderPattern(escaped)), '')
  return stripped.trim() === '' ? text : stripped
}
