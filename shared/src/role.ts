const SUMMARY_CHARS = 100

const firstLine = (body: string) =>
  body
    .split('\n')
    .map((part) => part.replace(/^\s*(?:#+|[-*])\s*/, '').trim())
    .find((part) => part !== '')

const clipTo = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 3)}...`)

/** How other agents see a role pack: its first line, led by the pack's name unless it already is. */
export function roleLabel(name: string, body: string, max = SUMMARY_CHARS): string {
  const line = firstLine(body)
  if (line === undefined) {
    return clipTo(name, max)
  }
  return clipTo(line.toLowerCase().startsWith(name.toLowerCase()) ? line : `${name}: ${line}`, max)
}
