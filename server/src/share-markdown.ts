import { Marked, type Token } from 'marked'

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

export const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char)

/** Web, mail and in-page links; javascript:, data:, relative paths and the rest lose the link. */
const SAFE_HREF = /^(https?:\/\/|mailto:|#)/i

const REL = 'noopener noreferrer nofollow'

/** Reads Markdown as GitHub does, for finding image links; rendering uses its own instance. */
const lexer = new Marked({ gfm: true, async: false })

/** Links of the images a Markdown file shows, inline and by reference, as written. */
export function markdownImages(text: string): string[] {
  const links = new Set<string>()
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit)
    } else if (typeof value === 'object' && value !== null) {
      const token = value as Partial<Token> & { href?: unknown }
      if (token.type === 'image' && typeof token.href === 'string') {
        links.add(token.href)
      }
      Object.values(value).forEach(visit)
    }
  }
  visit(lexer.lexer(text))
  return [...links]
}

/** An image without a snapshot shows its alt text in brackets, or nothing. */
const altOnly = (alt: string) => (alt === '' ? '' : escapeHtml(`[${alt}]`))

/**
 * Markdown as HTML with no way to run anything: raw HTML shows as text, links go only to the web
 * and mail, and an image shows only as its snapshot's inline data, else as its alt text.
 */
export function renderMarkdown(text: string, images: ReadonlyMap<string, string>): string {
  const marked = new Marked({
    gfm: true,
    async: false,
    renderer: {
      html: ({ text: raw }) => escapeHtml(raw),
      link({ href, tokens }) {
        const inner = this.parser.parseInline(tokens)
        return SAFE_HREF.test(href) ? `<a href="${escapeHtml(href)}" rel="${REL}">${inner}</a>` : inner
      },
      image({ href, text: alt }) {
        const data = images.get(href)
        return data === undefined ? altOnly(alt) : `<img src="${data}" alt="${escapeHtml(alt)}">`
      },
    },
  })
  return marked.parse(text, { async: false })
}
