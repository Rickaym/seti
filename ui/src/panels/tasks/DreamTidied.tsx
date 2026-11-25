import type { DreamTidy } from '@seti/shared'
import { Undo2 } from 'lucide-react'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'

function TidyLine({ tidy, onUndo }: { tidy: DreamTidy; onUndo: (tidy: DreamTidy) => void }) {
  return (
    <li className="flex items-center justify-between gap-2">
      <span className="min-w-0">
        Unsubscribed from <span className="font-medium text-foreground">{tidy.label}</span>: {tidy.reason}
      </span>
      {tidy.state === 'undone' ? (
        <span className="shrink-0">Undone</span>
      ) : (
        <Hint text={`Subscribe again to ${tidy.label}, as it was before this dream`}>
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0"
            aria-label={`Undo unsubscribe from ${tidy.label}`}
            onClick={() => {
              onUndo(tidy)
            }}
          >
            <Undo2 />
            Undo
          </Button>
        </Hint>
      )}
    </li>
  )
}

/** The dream's Tidied lines, then the configuration Seti changed for it, each with Undo. */
export function DreamTidied({
  lines,
  tidies,
  onUndo,
}: {
  lines: readonly string[]
  tidies: readonly DreamTidy[]
  onUndo: (tidy: DreamTidy) => void
}) {
  if (lines.length === 0 && tidies.length === 0) {
    return null
  }
  return (
    <div className="grid gap-0.5">
      <p className="text-2xs font-medium">Tidied</p>
      {lines.length > 0 && (
        <ul aria-label="Tidied" className="grid list-disc gap-0.5 pl-4 text-2xs text-muted-foreground">
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
      {tidies.length > 0 && (
        <ul aria-label="Configuration changes" className="grid gap-0.5 pl-4 text-2xs text-muted-foreground">
          {tidies.map((tidy) => (
            <TidyLine key={tidy.id} tidy={tidy} onUndo={onUndo} />
          ))}
        </ul>
      )}
    </div>
  )
}
