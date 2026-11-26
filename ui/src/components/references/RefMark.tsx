import { ExternalLink } from 'lucide-react'
import { useState, type MouseEvent } from 'react'
import { ReferencePreview } from '@/components/references/ReferencePreview'
import { Button } from '@/components/ui/button'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { useCoarsePointer } from '@/hooks/useMedia'
import { useSourceLabel, type SourceLabel } from '@/lib/references/reference-label'
import type { Reference } from '@/lib/references/reference-set'
import { cn } from '@/lib/utils'

const MARK = cn(
  'relative -top-[0.45em] mx-px inline-flex cursor-pointer items-center px-px align-baseline',
  'text-[max(0.75em,11px)] leading-none font-medium text-primary tabular-nums no-underline',
  'hover:underline focus-visible:outline-2 focus-visible:outline-ring',
  'pointer-coarse:-my-4 pointer-coarse:min-h-11 pointer-coarse:px-0.5',
)

interface MarkProps {
  reference: Reference
  label: SourceLabel
}

/** The mark itself: a link to the source, or a button for a footnote without a link. */
function MarkTrigger({
  reference,
  label,
  onClick,
  ...props
}: MarkProps & { onClick?: ((event: MouseEvent<HTMLElement>) => void) | undefined }) {
  const shared = {
    ...props,
    className: MARK,
    'aria-label': `Source ${String(reference.n)}: ${label.label}`,
    'data-reference': reference.n,
    onClick,
  }
  const text = `[${String(reference.n)}]`
  return reference.href === null ? (
    <button type="button" {...shared}>
      {text}
    </button>
  ) : (
    <a href={reference.href} target="_blank" rel="noreferrer" {...shared}>
      {text}
    </a>
  )
}

/** Hover or focus shows the preview card; a click opens the source in a new tab. */
function DesktopMark({ reference, label }: MarkProps) {
  const [open, setOpen] = useState(false)
  const toggle =
    reference.href === null
      ? () => {
          setOpen((shown) => !shown)
        }
      : undefined
  return (
    <HoverCard open={open} onOpenChange={setOpen} openDelay={150} closeDelay={100}>
      <HoverCardTrigger asChild>
        <MarkTrigger reference={reference} label={label} onClick={toggle} />
      </HoverCardTrigger>
      <HoverCardContent side="top" className="w-72">
        <ReferencePreview reference={reference} label={label} />
      </HoverCardContent>
    </HoverCard>
  )
}

/** A tap opens a bottom sheet with the preview and an Open button. */
function PhoneMark({ reference, label }: MarkProps) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <MarkTrigger
        reference={reference}
        label={label}
        onClick={(event) => {
          event.preventDefault()
          setOpen(true)
        }}
      />
      {open && (
        <Sheet open onOpenChange={setOpen}>
          <SheetContent side="bottom" aria-describedby={undefined} className="p-0" data-testid="reference-sheet">
            <div className="flex flex-col gap-3 p-4">
              <SheetTitle>Source {reference.n}</SheetTitle>
              <ReferencePreview reference={reference} label={label} />
              {reference.href !== null && (
                <Button asChild className="min-h-11">
                  <a href={reference.href} target="_blank" rel="noreferrer">
                    <ExternalLink />
                    Open
                  </a>
                </Button>
              )}
            </div>
          </SheetContent>
        </Sheet>
      )}
    </>
  )
}

/** A reference's superscript `[n]` mark, with a preview card on desktop and a sheet on a phone. */
export function RefMark({ reference }: { reference: Reference }) {
  const label = useSourceLabel(reference)
  return useCoarsePointer() ? (
    <PhoneMark reference={reference} label={label} />
  ) : (
    <DesktopMark reference={reference} label={label} />
  )
}
