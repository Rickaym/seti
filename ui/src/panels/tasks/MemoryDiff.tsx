import type { Revision, RevisionState } from '@seti/shared'
import { Undo2 } from 'lucide-react'
import { useId, useState } from 'react'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { LineDiff } from '@/panels/revisions/FieldChange'

const fileOf = (revision: Revision) => revision.object_id.slice(revision.object_id.indexOf(':') + 1)

const textOf = (state: RevisionState | null) => (typeof state?.text === 'string' ? state.text : '')

function whatHappened(revision: Revision): string {
  if (revision.before?.deleted === true) {
    return 'The dream created this file.'
  }
  return revision.after?.deleted === true ? 'The dream deleted this file.' : 'The dream changed this file.'
}

/** What the dream did to the file, and whether Seti shows any of it redacted. */
function changeLine(revision: Revision): string {
  const what = whatHappened(revision)
  const redacted = revision.before?.redacted === true || revision.after?.redacted === true
  return redacted ? `${what} Credentials in it show redacted.` : what
}

interface DiffProps {
  revision: Revision
  onUndo: (revision: Revision) => void
  onClose: () => void
}

/** One memory file's change, before and after as Seti stored them, with Undo beside it. */
function MemoryDiffDialog({ revision, onUndo, onClose }: DiffProps) {
  const file = fileOf(revision)
  const described = useId()
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) {
          onClose()
        }
      }}
    >
      <DialogContent aria-describedby={described} className="flex max-h-[92dvh] min-h-0 flex-col gap-2 sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-mono break-all">{file}</DialogTitle>
        </DialogHeader>
        <p id={described} className="text-2xs text-muted-foreground">
          {changeLine(revision)}
        </p>
        <LineDiff
          before={textOf(revision.before)}
          after={textOf(revision.after)}
          className="max-h-none min-h-0 flex-1"
        />
        <DialogFooter>
          <Hint text={`Put ${file} back as it was before this dream`}>
            <Button
              variant="outline"
              size="sm"
              aria-label={`Undo ${file}`}
              onClick={() => {
                onUndo(revision)
                onClose()
              }}
            >
              <Undo2 />
              Undo
            </Button>
          </Hint>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** The memory files a dream changed: each opens its diff, and each can go back with Undo. */
export function MemoryChanges({
  changes,
  onUndo,
}: {
  changes: readonly Revision[]
  onUndo: (revision: Revision) => void
}) {
  const [shown, setShown] = useState<Revision | null>(null)
  return (
    <>
      <ul aria-label="Memory changes" className="grid gap-1">
        {changes.map((revision) => {
          const file = fileOf(revision)
          return (
            <li key={revision.id} className="flex items-center justify-between gap-2 text-2xs">
              <Hint text="See what the dream changed">
                <Button
                  variant="ghost"
                  size="sm"
                  className="min-w-0 justify-start font-mono"
                  onClick={() => {
                    setShown(revision)
                  }}
                >
                  <span className="truncate">{file}</span>
                </Button>
              </Hint>
              <Hint text={`Put ${file} back as it was before this dream`}>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Undo ${file}`}
                  onClick={() => {
                    onUndo(revision)
                  }}
                >
                  <Undo2 />
                  Undo
                </Button>
              </Hint>
            </li>
          )
        })}
      </ul>
      {shown !== null && (
        <MemoryDiffDialog
          revision={shown}
          onUndo={onUndo}
          onClose={() => {
            setShown(null)
          }}
        />
      )}
    </>
  )
}
