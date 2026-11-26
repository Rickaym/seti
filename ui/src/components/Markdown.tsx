import { guessLanguage, languageOfClasses } from '@seti/shared'
import { defaultSchema, type Schema } from 'hast-util-sanitize'
import { Suspense, useContext, useMemo, useState, type ComponentProps, type ComponentType, type ReactNode } from 'react'
import MarkdownRoot, { type Components, type ExtraProps, type Options } from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
import { CODE_COPY, CODE_COPY_ROOM, CopyIconButton } from '@/components/CopyButton'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { HighlightedCode } from '@/components/highlight/HighlightedCode'
import { LinkPill } from '@/components/links/LinkPill'
import { MarkdownImagesContext } from '@/components/markdown-images'
import { InlineReference, ReferenceQuote, ReferenceSup, SourcesSlot } from '@/components/references/markdown-references'
import { INLINE_LINK, ReferencesContext, useReferenceOf } from '@/components/references/reference-context'
import { useFenceRenderer } from '@/lib/fence-renderers'
import { pathOfHref, remarkFilePaths } from '@/lib/file-paths'
import { textIsUrl } from '@/lib/links/bare-urls'
import { pillOf } from '@/lib/links/link-label'
import { newToken, REF_PROPERTY, SOURCES_PROPERTY, type ReferenceSet } from '@/lib/references/reference-set'
import { remarkReferences } from '@/lib/references/remark-references'
import { cn } from '@/lib/utils'
import { useViewTheme } from '@/lib/view-theme'

const HEADING = 'pt-1 font-semibold'
const MINOR_HEADING = `${HEADING} text-xs tracking-wide text-muted-foreground uppercase`
const CELL = 'border border-border px-2 py-1 text-left align-top'
const NO_LIGATURES = '[font-variant-ligatures:none]'

/** The text of a link that holds nothing but text; null when it holds code or other markup. */
function plainText(node: ExtraProps['node']): string | null {
  const children = node?.children ?? []
  const texts = children.flatMap((child) => (child.type === 'text' ? [child.value] : []))
  return children.length > 0 && texts.length === children.length ? texts.join('') : null
}

/**
 * In-page links stay in the page; a link inside a sentence is a reference; a bare URL shows as a
 * pill; the rest open in a new tab.
 */
function Anchor({ node, children, ...props }: ComponentProps<'a'> & ExtraProps) {
  const { href } = props
  const reference = useReferenceOf(node)
  if (href?.startsWith('#') === true) {
    return <a {...props}>{children}</a>
  }
  const text = plainText(node)
  const bare = href !== undefined && text !== null && textIsUrl(text, href)
  if (reference !== null && href !== undefined && reference.href === href) {
    return (
      <InlineReference reference={reference} bare={bare}>
        {children}
      </InlineReference>
    )
  }
  const pill = bare ? pillOf(href) : null
  if (pill !== null && href !== undefined) {
    return <LinkPill href={href} info={pill} />
  }
  return (
    <a {...props} target="_blank" rel="noreferrer" className={INLINE_LINK}>
      {children}
    </a>
  )
}

interface Fence {
  code: string
  classes: unknown
}

/** The code of a fenced block and its code element's classes, which name its language. */
function fenceOf(node: ExtraProps['node']): Fence | null {
  const code = node?.children.length === 1 ? node.children[0] : undefined
  if (code?.type !== 'element' || code.tagName !== 'code') {
    return null
  }
  const text = code.children.map((child) => (child.type === 'text' ? child.value : '')).join('')
  return { code: text, classes: code.properties.className }
}

/** The language a fence's classes name, such as mermaid for language-mermaid; null for none. */
function fenceLanguage(classes: unknown): string | null {
  const names: unknown[] = Array.isArray(classes) ? classes : []
  const tag = names.find((name): name is string => typeof name === 'string' && name.startsWith('language-'))
  return tag === undefined ? null : tag.slice('language-'.length)
}

const hasLanguage = (classes: unknown) =>
  Array.isArray(classes) && classes.some((name) => typeof name === 'string' && name.startsWith('language-'))

const PRE = cn(
  'overflow-x-auto border border-border bg-code/60 px-3 py-2 font-mono text-xs leading-normal',
  '[&>code]:border-0 [&>code]:bg-transparent [&>code]:p-0 [&>code]:text-[inherit] max-md:[&>code]:text-[1em]',
  NO_LIGATURES,
)

/** A fenced block coloured by its tag, or by a cheap guess when it has none, with a copy button. */
function FenceCode({ code, classes }: Fence) {
  const language = useMemo(
    () => (hasLanguage(classes) ? languageOfClasses(classes) : guessLanguage(code)),
    [code, classes],
  )
  return (
    <div className="group/code relative">
      <pre className={cn(PRE, CODE_COPY_ROOM)}>
        <HighlightedCode
          code={code}
          language={language}
          className={Array.isArray(classes) ? classes.join(' ') : undefined}
        />
      </pre>
      <CopyIconButton text={code.replace(/\n$/, '')} label="Copy code" className={CODE_COPY} />
    </div>
  )
}

/** A fence a renderer draws, such as a diagram, or its code when none does. */
function RenderedFence({ code, classes }: Fence) {
  const renderer = useFenceRenderer(fenceLanguage(classes))
  const theme = useViewTheme()
  if (renderer === undefined) {
    return <FenceCode code={code} classes={classes} />
  }
  const View = renderer.view
  return (
    <ErrorBoundary name="This block" kind="inline">
      <Suspense fallback={<pre className={PRE}>{code}</pre>}>
        <View source={code} theme={theme} />
      </Suspense>
    </ErrorBoundary>
  )
}

function Pre({ node, ...props }: ComponentProps<'pre'> & ExtraProps) {
  const fence = fenceOf(node)
  return fence === null ? (
    <pre {...props} className={PRE} />
  ) : (
    <RenderedFence code={fence.code} classes={fence.classes} />
  )
}

type HeadingTag = 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'

/** A heading in its style; a class the source gives, such as sr-only, stays. */
const heading = (Tag: HeadingTag, style: string) =>
  function Heading({ node: _node, className, ...props }: ComponentProps<HeadingTag> & ExtraProps) {
    return <Tag {...props} className={cn(className, style)} />
  }

const components: Components = {
  blockquote: ReferenceQuote,
  sup: ReferenceSup,
  section: SourcesSlot,
  h1: heading('h1', `${HEADING} border-b border-border pb-1 text-lg text-foreground`),
  h2: heading('h2', `${HEADING} text-base text-foreground`),
  h3: heading('h3', `${HEADING} text-sm text-foreground/85`),
  h4: heading('h4', MINOR_HEADING),
  h5: heading('h5', MINOR_HEADING),
  h6: heading('h6', MINOR_HEADING),
  ul: ({ node: _node, ...props }) => (
    <ul {...props} className="list-disc space-y-0.5 pl-5 marker:text-muted-foreground" />
  ),
  ol: ({ node: _node, ...props }) => (
    <ol {...props} className="list-decimal space-y-0.5 pl-5 marker:text-muted-foreground" />
  ),
  li: ({ node: _node, className, ...props }) => (
    <li {...props} className={cn(className, '[&.task-list-item]:list-none [&>ol]:mt-0.5 [&>p+p]:mt-1 [&>ul]:mt-0.5')} />
  ),
  input: ({ node: _node, ...props }) => <input {...props} className="mr-2 -ml-5 align-middle accent-primary" />,
  a: Anchor,
  strong: ({ node: _node, ...props }) => <strong {...props} className="font-semibold text-foreground" />,
  hr: ({ node: _node, ...props }) => <hr {...props} className="border-border" />,
  code: ({ node: _node, ...props }) => (
    <code {...props} className={cn('border border-border bg-code px-1 py-px font-mono text-[0.85em]', NO_LIGATURES)} />
  ),
  pre: Pre,
  table: ({ node: _node, ...props }) => (
    <div className="overflow-x-auto">
      <table {...props} className="border-collapse text-xs" />
    </div>
  ),
  th: ({ node: _node, ...props }) => <th {...props} className={`${CELL} bg-muted font-semibold`} />,
  td: ({ node: _node, ...props }) => <td {...props} className={CELL} />,
  details: ({ node: _node, ...props }) => (
    <details {...props} className="space-y-2 border border-border px-2 py-1 [&[open]>summary]:mb-1" />
  ),
  summary: ({ node: _node, ...props }) => (
    <summary {...props} className="cursor-pointer text-muted-foreground select-none hover:text-foreground" />
  ),
  img: function Image({ node: _node, alt, src, ...props }) {
    const source = useContext(MarkdownImagesContext)
    const shown = typeof src === 'string' ? (source?.(src) ?? src) : src
    return <img {...props} src={shown} alt={alt ?? ''} loading="lazy" className="inline h-auto max-w-full" />
  },
}

const allowed = (tag: string, ...names: string[]) => [...(defaultSchema.attributes?.[tag] ?? []), ...names]

/**
 * GitHub's own allowlist; the prefix keeps ids from comments out of the page's id space. The
 * reference properties pass, and only the ones this view's token signs count.
 */
const githubSchema: Schema = {
  ...defaultSchema,
  clobberPrefix: 'gh-',
  attributes: {
    ...defaultSchema.attributes,
    a: allowed('a', REF_PROPERTY),
    blockquote: allowed('blockquote', REF_PROPERTY),
    sup: allowed('sup', REF_PROPERTY),
    section: allowed('section', SOURCES_PROPERTY),
  },
}

const githubHtml: NonNullable<Options['rehypePlugins']> = [rehypeRaw, [rehypeSanitize, githubSchema]]

const PROSE = 'min-w-0 space-y-2 text-sm leading-relaxed break-words'

export interface FileMentionProps {
  /** The path or Files link as the text has it. */
  path: string
  /** What the text shows while the file is unknown; for a card, its whole paragraph or line. */
  children: ReactNode
  /** The reference is a paragraph of its own, so it can show as a card. */
  card?: boolean
}

/** Renders a file path the text mentions, such as a link that opens it when it exists. */
export type FileLinkRenderer = ComponentType<FileMentionProps>

/** The file a paragraph holds when a file reference is all it holds. */
function lonePath(node: ExtraProps['node']): string | null {
  const parts = node?.children.filter((child) => child.type !== 'text' || child.value.trim() !== '') ?? []
  const [only] = parts
  if (parts.length !== 1 || only?.type !== 'element' || only.tagName !== 'a') {
    return null
  }
  const { href } = only.properties
  return typeof href === 'string' ? pathOfHref(href) : null
}

function withFileLinks(FileLink: FileLinkRenderer): Components {
  return {
    ...components,
    a: (props): ReactNode => {
      const path = pathOfHref(props.href)
      return path === null ? <Anchor {...props} /> : <FileLink path={path}>{props.children}</FileLink>
    },
    p: ({ node, ...props }): ReactNode => {
      const path = lonePath(node)
      return path === null ? (
        <p {...props} />
      ) : (
        <FileLink path={path} card>
          <p {...props} />
        </FileLink>
      )
    },
  }
}

/**
 * GitHub-flavoured Markdown; raw HTML is escaped unless `html`, which renders it sanitized. Links
 * inside sentences and footnotes become numbered references with a Sources list unless
 * `references` is false, as for documents.
 */
export function Markdown({
  text,
  html = false,
  plugins = [],
  fileLink,
  references = true,
  className,
}: {
  text: string
  html?: boolean
  plugins?: NonNullable<Options['remarkPlugins']>
  /** Renders the file paths and Files links in the text, such as chips that open the Files view. */
  fileLink?: FileLinkRenderer | undefined
  references?: boolean
  className?: string
}) {
  const [set] = useState<ReferenceSet>(() => ({ token: newToken(), refs: [] }))
  const rendered = useMemo(() => (fileLink === undefined ? components : withFileLinks(fileLink)), [fileLink])
  const remark = [
    remarkGfm,
    ...plugins,
    ...(fileLink === undefined ? [] : [remarkFilePaths]),
    ...(references ? [remarkReferences(set)] : []),
  ]
  return (
    <div className={cn(PROSE, className)}>
      <ReferencesContext value={references ? set : null}>
        <MarkdownRoot remarkPlugins={remark} rehypePlugins={html ? githubHtml : []} components={rendered}>
          {text}
        </MarkdownRoot>
      </ReferencesContext>
    </div>
  )
}
