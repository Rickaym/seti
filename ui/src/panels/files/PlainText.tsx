import { useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'

/** The monospace look of file text, shared by the view and the editor. */
export const MONO = 'font-mono text-xs leading-relaxed [font-variant-ligatures:none]'

/** Plain text with one line marked and scrolled into view. */
export function PlainText({ text, line }: { text: string; line: number | undefined }) {
  const marked = useRef<HTMLElement>(null)
  useEffect(() => {
    marked.current?.scrollIntoView({ block: 'center' })
  }, [line])
  const lines = line === undefined ? [] : text.split('\n')
  if (line === undefined || line < 1 || line > lines.length) {
    return <pre className={cn(MONO, 'break-all whitespace-pre-wrap')}>{text}</pre>
  }
  const before = lines.slice(0, line - 1).join('\n')
  const after = lines.slice(line).join('\n')
  return (
    <pre className={cn(MONO, 'break-all whitespace-pre-wrap')}>
      {line > 1 && `${before}\n`}
      <mark ref={marked} data-line={line} className="bg-warning/30 text-inherit">
        {lines[line - 1]}
      </mark>
      {line < lines.length && `\n${after}`}
    </pre>
  )
}
