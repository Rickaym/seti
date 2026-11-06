import type { CodeLanguage } from '@seti/shared'
import { highlight, highlightRanges, type Segment } from '@seti/shared/highlight'
import { describe, expect, it } from 'vitest'

const classed = (segments: Segment[], className: string) =>
  segments.filter((segment) => segment.className === className).map((segment) => segment.text.trim())

const SAMPLES: Record<CodeLanguage, { code: string; keyword?: string; string?: string }> = {
  javascript: { code: "const a = 'x'", keyword: 'const', string: "'x'" },
  typescript: { code: "export const a: string = 'x'", keyword: 'export', string: "'x'" },
  jsx: { code: 'return <div className="x" />', keyword: 'return' },
  tsx: { code: 'const a: number = <b>{1}</b>', keyword: 'const' },
  python: { code: 'def f():\n    return "x"', keyword: 'def', string: '"x"' },
  bash: { code: 'if true; then echo "x"; fi', keyword: 'if', string: '"x"' },
  json: { code: '{"a": "x", "b": true}', string: '"x"' },
  yaml: { code: 'name: "x"\nlist:\n  - 1', string: '"x"' },
  sql: { code: "SELECT * FROM t WHERE a = 'x'", keyword: 'SELECT', string: "'x'" },
  go: { code: 'func main() { s := "x" }', keyword: 'func', string: '"x"' },
  rust: { code: 'fn main() { let s = "x"; }', keyword: 'fn', string: '"x"' },
  diff: { code: '@@ -1 +1 @@\n-old\n+new' },
  css: { code: '.a { color: red; content: "x"; }', string: '"x"' },
  html: { code: '<div class="x"><script>const a = 1</script></div>', keyword: 'div', string: '"x"' },
  xml: { code: '<?xml version="1.0"?>\n<a href="x"><b/></a>', keyword: 'a', string: '"x"' },
  markdown: { code: '# Title\n\nSome `code` and **bold**.' },
  dockerfile: { code: 'FROM node:24\nRUN echo "x"', keyword: 'FROM', string: '"x"' },
  makefile: { code: 'build: deps\n\tgo build "x" $(FLAGS)', string: '"x"' },
  toml: { code: '[server]\nname = "x"\nport = 80', string: '"x"' },
  ini: { code: '# comment\nAPI_KEY=secret\n[section]' },
}

describe('static highlighting', () => {
  it.each(Object.entries(SAMPLES))('colours %s and keeps its text intact', async (language, sample) => {
    const segments = await highlight(sample.code, language as CodeLanguage)
    expect(segments.map((segment) => segment.text).join('')).toBe(sample.code)
    expect(segments.some((segment) => segment.className !== '')).toBe(true)
    if (sample.keyword !== undefined) {
      expect(classed(segments, 'tok-keyword')).toContain(sample.keyword)
    }
    if (sample.string !== undefined) {
      expect(classed(segments, 'tok-string').join(' ')).toContain(sample.string)
    }
  })

  it('colours JSON keys, literals and nested script in HTML', async () => {
    const json = await highlight('{"key": 12, "on": null}', 'json')
    expect(classed(json, 'tok-function')).toContain('"key"')
    expect(classed(json, 'tok-literal')).toEqual(expect.arrayContaining(['12', 'null']))
    const html = await highlight('<script>const a = 1</script>', 'html')
    expect(classed(html, 'tok-keyword')).toContain('const')
  })

  it('colours only the keys of env and ini files', async () => {
    const segments = await highlight('# local\nAPI_KEY=secret value\nport: 80', 'ini')
    expect(classed(segments, 'tok-function')).toEqual(['API_KEY', 'port'])
    expect(classed(segments, 'tok-comment')).toEqual(['# local'])
    expect(segments.find((segment) => segment.text.includes('secret'))?.className).toBe('')
  })

  it('colours Makefile targets, variables and references', async () => {
    const segments = await highlight('CC := gcc\nbuild: main.o\n\t$(CC) -o app $@ # link', 'makefile')
    expect(classed(segments, 'tok-function')).toEqual(['CC', 'build'])
    expect(classed(segments, 'tok-literal')).toEqual(['$(CC)', '$@'])
    expect(classed(segments, 'tok-comment')).toEqual(['# link'])
  })

  it('colours Markdown headings and code as code', async () => {
    const segments = await highlight('# Title\n\n`code`', 'markdown')
    expect(classed(segments, 'tok-meta').join(' ')).toContain('Title')
  })

  it('colours a range of a long file from one parse', async () => {
    const code = 'const a = 1\n/* a comment\nspanning lines */\nconst b = "x"'
    const [first = [], second = []] = await highlightRanges(code, 'typescript', [
      { from: 0, to: 11 },
      { from: 25, to: code.length },
    ])
    expect(classed(first, 'tok-keyword')).toEqual(['const'])
    expect(classed(second, 'tok-comment')).toEqual(['spanning lines */'])
    expect(classed(second, 'tok-string')).toEqual(['"x"'])
  })

  it('colours diff lines by their first character', async () => {
    const segments = await highlight('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n same', 'diff')
    expect(classed(segments, 'tok-deleted')).toEqual(['-old'])
    expect(classed(segments, 'tok-inserted')).toEqual(['+new'])
    expect(classed(segments, 'tok-meta')).toEqual(['--- a/x', '+++ b/x', '@@ -1 +1 @@'])
  })
})
