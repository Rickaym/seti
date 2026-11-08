import { Lexer, type Token } from 'marked'

/** A fenced block of a Markdown file: its language, such as mermaid, and its text. */
export interface MarkdownFence {
  language: string
  source: string
}

/** The language a fence's info string names: its first word, as the in-app view reads it. */
export const fenceLanguage = (info: string | undefined): string => (info ?? '').trim().split(/\s+/, 1)[0] ?? ''

/** How a fence is matched to what was drawn of it: language and exact text. */
export const fenceKey = (language: string, source: string) => `${language}\n${source}`

const isFence = (token: Token): token is Token & { type: 'code'; text: string; lang?: string } =>
  token.type === 'code' && (token as { codeBlockStyle?: string }).codeBlockStyle !== 'indented'

/** Every fenced block, nested ones included, read as GitHub reads Markdown. */
export function markdownFences(text: string): MarkdownFence[] {
  const fences: MarkdownFence[] = []
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit)
    } else if (typeof value === 'object' && value !== null) {
      const token = value as Token
      if (isFence(token)) {
        fences.push({ language: fenceLanguage(token.lang), source: token.text })
        return
      }
      Object.values(value).forEach(visit)
    }
  }
  visit(new Lexer({ gfm: true, async: false }).lex(text))
  return fences
}
