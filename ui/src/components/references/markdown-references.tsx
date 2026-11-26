import { useContext, type ComponentProps, type ReactNode } from 'react'
import type { ExtraProps } from 'react-markdown'
import { LinkIcon } from '@/components/links/LinkPill'
import { RefMark } from '@/components/references/RefMark'
import { SourcesList } from '@/components/references/SourcesList'
import { INLINE_LINK, ReferencesContext, useReferenceOf } from '@/components/references/reference-context'
import { useSourceLabel } from '@/lib/references/reference-label'
import { isSourcesOf, SOURCES_PROPERTY, type Reference } from '@/lib/references/reference-set'

const REF_ATTRIBUTE = 'data-seti-ref'

/** Props without the reference attribute, for elements that pass on what Markdown gives them. */
const withoutRef = <T extends object>(props: T): T =>
  Object.fromEntries(Object.entries(props).filter(([key]) => key !== REF_ATTRIBUTE)) as T

/** A link inside a sentence: its text, or the label of a bare URL, then its mark. */
export function InlineReference({
  reference,
  bare,
  children,
}: {
  reference: Reference
  bare: boolean
  children: ReactNode
}) {
  const label = useSourceLabel(reference)
  return (
    <>
      <a href={reference.href ?? undefined} target="_blank" rel="noreferrer" className={INLINE_LINK}>
        {bare ? label.label : children}
      </a>
      <RefMark reference={reference} />
    </>
  )
}

function QuoteSource({ reference }: { reference: Reference }) {
  const label = useSourceLabel(reference)
  return (
    <figcaption
      className="flex min-w-0 items-center gap-1 pl-3 text-xs text-muted-foreground"
      data-testid="quote-source"
    >
      <LinkIcon info={label} className="size-3" />
      <span className="min-w-0 truncate">{label.label}</span>
      {label.host !== null && <span className="shrink-0">{label.host}</span>}
    </figcaption>
  )
}

const QUOTE = 'space-y-2 border-l-2 border-border pl-3 text-muted-foreground'

/** A quote, with a source line under it when a reference is tied to it. */
export function ReferenceQuote({ node, ...props }: ComponentProps<'blockquote'> & ExtraProps) {
  const reference = useReferenceOf(node)
  const quote = <blockquote {...withoutRef(props)} className={QUOTE} />
  return reference === null ? (
    quote
  ) : (
    <figure className="space-y-1">
      {quote}
      <QuoteSource reference={reference} />
    </figure>
  )
}

/** A footnote or `[n]` mark. */
export function ReferenceSup({ node, ...props }: ComponentProps<'sup'> & ExtraProps) {
  const reference = useReferenceOf(node)
  return reference === null ? <sup {...withoutRef(props)} /> : <RefMark reference={reference} />
}

/** Where the Sources list goes. */
export function SourcesSlot({ node, ...props }: ComponentProps<'section'> & ExtraProps) {
  const set = useContext(ReferencesContext)
  return set !== null && isSourcesOf(set, node?.properties[SOURCES_PROPERTY]) ? (
    <SourcesList refs={set.refs} />
  ) : (
    <section {...props} />
  )
}
