import { Markdown } from '@/components/Markdown'
import { remarkNoImages } from './mod-markdown'

const PLUGINS = [remarkNoImages]

/** A mod's own Markdown: raw HTML shows as text, images as links, and links open in a new tab. */
export function ModMarkdown({ text, empty }: { text: string | null; empty: string }) {
  return text === null || text.trim() === '' ? (
    <p className="text-muted-foreground">{empty}</p>
  ) : (
    <Markdown text={text} plugins={PLUGINS} className="max-w-[72ch] text-sm" />
  )
}
