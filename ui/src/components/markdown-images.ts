import { createContext } from 'react'

/** Turns an image source a Markdown file names into a URL the page can load; null leaves it. */
export type ImageSource = (src: string) => string | null

export const MarkdownImagesContext = createContext<ImageSource | null>(null)

const SCHEME = /^[a-z][a-z0-9+.-]*:/i

/** The path an image link names relative to the Markdown file at `base`; null when not relative. */
export function relativeAsset(base: string, src: string): string | null {
  if (src === '' || SCHEME.test(src) || src.startsWith('/') || src.startsWith('#')) {
    return null
  }
  const [link = ''] = src.split(/[?#]/)
  let decoded: string
  try {
    decoded = decodeURIComponent(link)
  } catch {
    return null
  }
  const dir = base.includes('/') ? base.slice(0, base.lastIndexOf('/')) : ''
  const out: string[] = []
  for (const part of [...dir.split('/'), ...decoded.split('/')]) {
    if (part === '' || part === '.') {
      continue
    }
    if (part === '..') {
      if (out.length === 0) {
        return null
      }
      out.pop()
    } else {
      out.push(part)
    }
  }
  return out.length === 0 ? null : out.join('/')
}
