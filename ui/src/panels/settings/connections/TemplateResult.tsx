import type { Connection } from '@seti/shared'
import { ArrowRight, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { TestMint } from './TestMint'
import { kindLabel, statusText } from './connection-form'

function Made({ connection, onOpen }: { connection: Connection; onOpen: () => void }) {
  const carriers = connection.profiles.map((profile) => profile.name).join(', ')
  const status = statusText(connection)
  return (
    <li aria-label={connection.name} className="border-b border-border px-4 py-3 last:border-b-0">
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate font-mono text-sm font-medium">{connection.name}</span>
        <span className="shrink-0 text-2xs text-muted-foreground">{kindLabel(connection)}</span>
      </div>
      <p className="mt-1 font-mono text-2xs wrap-anywhere text-muted-foreground">
        {connection.hosts.join(', ')} - {connection.env}
      </p>
      <p className="mt-1 text-muted-foreground">
        {carriers === '' ? 'In no credential yet; open it to switch one on.' : `In ${carriers}.`}
        {status !== null && ` ${status}.`}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {connection.kind !== 'key' && connection.missing.length === 0 && (
          <TestMint connection={connection} onTested={() => undefined} />
        )}
        <Button size="sm" variant="outline" aria-label={`Open ${connection.name}`} onClick={onOpen}>
          <ArrowRight />
          Open
        </Button>
      </div>
    </li>
  )
}

/** What a template just added, each with a test of its token and a way to its own page. */
export function TemplateResult({
  title,
  made,
  onOpen,
  onClose,
}: {
  title: string
  made: readonly Connection[]
  onOpen: (id: string) => void
  onClose: () => void
}) {
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) {
          onClose()
        }
      }}
    >
      <DialogContent className="flex max-h-[92vh] min-h-0 flex-col gap-0 overflow-hidden border p-0 sm:max-w-2xl">
        <DialogHeader className="border-b border-border px-4 py-3">
          <DialogTitle>{title} added</DialogTitle>
        </DialogHeader>
        <ul aria-label="Added" className="min-h-0 flex-1 overflow-y-auto text-xs">
          {made.map((connection) => (
            <Made
              key={connection.id}
              connection={connection}
              onOpen={() => {
                onOpen(connection.id)
              }}
            />
          ))}
        </ul>
        <DialogFooter className="border-t border-border px-4 py-3">
          <Button type="button" size="sm" onClick={onClose}>
            <Check />
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
