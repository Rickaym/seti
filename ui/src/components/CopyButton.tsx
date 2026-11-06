import { Check, Copy } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

const copyFailed = () => toast.error('Copy failed; select the text instead')

export function CopyButton({ text, label }: { text: string; label: string }) {
  const copy = () => {
    navigator.clipboard.writeText(text).then(() => toast.success(`${label} copied`), copyFailed)
  }
  return (
    <Button size="icon-xs" variant="ghost" aria-label={`Copy ${label.toLowerCase()}`} onClick={copy}>
      <Copy />
    </Button>
  )
}

/** How long the check mark stays after a copy. */
const COPIED_MS = 1500

/** A quiet copy icon that turns into a check for a moment once the text is on the clipboard. */
export function CopyIconButton({
  text,
  label,
  className,
  variant = 'ghost',
}: {
  text: string
  label: string
  className?: string
  /** outline matches the bordered icon buttons of a header. */
  variant?: 'ghost' | 'outline'
}) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) {
      return undefined
    }
    const timer = setTimeout(() => {
      setCopied(false)
    }, COPIED_MS)
    return () => {
      clearTimeout(timer)
    }
  }, [copied])
  return (
    <Button
      size={variant === 'ghost' ? 'icon-xs' : 'icon-sm'}
      variant={variant}
      aria-label={label}
      title={copied ? 'Copied' : label}
      data-copied={copied ? '' : undefined}
      className={cn(
        variant === 'ghost' && 'text-muted-foreground hover:text-foreground',
        'data-copied:text-success',
        className,
      )}
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
        }, copyFailed)
      }}
    >
      {copied ? <Check /> : <Copy />}
    </Button>
  )
}

/** The corner of a `group/code` block where its copy button sits, shown on hover or focus. */
export const CODE_COPY =
  'absolute top-0.5 right-0.5 bg-background/90 pointer-fine:opacity-0 pointer-fine:group-hover/code:opacity-100 pointer-fine:group-focus-within/code:opacity-100 pointer-fine:data-copied:opacity-100'

/** Room at the right of a code block for its copy button, which touch screens always show. */
export const CODE_COPY_ROOM = 'pointer-coarse:min-h-12 pointer-coarse:pr-12'
