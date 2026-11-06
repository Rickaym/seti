import type { RewindFilesPreview, RewindRestore, RewindResult, RewindTarget } from '@seti/shared'
import { ArrowLeft, FileCode, History, Layers, MessageSquare } from 'lucide-react'
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { toast } from 'sonner'
import { apiGet, apiPost, errorText } from '@/api'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { relativeTime } from '@/lib/time'
import { cn } from '@/lib/utils'

const firstLine = (text: string) => text.trim().split('\n')[0] ?? ''

const messages = (count: number) => `${String(count)} ${count === 1 ? 'message' : 'messages'}`

const STEPS: Partial<Record<string, (at: number, last: number) => number>> = {
  ArrowDown: (at, last) => Math.min(at + 1, last),
  ArrowUp: (at) => Math.max(at - 1, 0),
  Home: () => 0,
  End: (_, last) => last,
}

/** Earlier prompts, newest first: arrows move, Enter or a click picks. */
function TargetList({ targets, onPick }: { targets: RewindTarget[] | null; onPick: (target: RewindTarget) => void }) {
  const listId = useId()
  const list = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState(0)

  useEffect(() => {
    list.current?.focus()
  }, [targets])

  if (targets === null) {
    return <p className="text-muted-foreground">Loading earlier prompts...</p>
  }
  if (targets.length === 0) {
    return <p className="text-muted-foreground">There is no earlier prompt to rewind to.</p>
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = STEPS[e.key]
    const picked = targets[active]
    if (step) {
      e.preventDefault()
      const next = step(active, targets.length - 1)
      setActive(next)
      document.getElementById(`${listId}-${String(next)}`)?.scrollIntoView({ block: 'nearest' })
    } else if (e.key === 'Enter' && picked) {
      e.preventDefault()
      onPick(picked)
    }
  }

  return (
    <div
      ref={list}
      role="listbox"
      tabIndex={0}
      aria-label="Earlier prompts"
      aria-activedescendant={`${listId}-${String(active)}`}
      className="max-h-80 overflow-y-auto py-1 outline-none focus-visible:ring-1 focus-visible:ring-ring"
      onKeyDown={onKeyDown}
    >
      {targets.map((target, index) => (
        <div
          key={target.message_id}
          id={`${listId}-${String(index)}`}
          role="option"
          tabIndex={-1}
          aria-selected={index === active}
          className={cn(
            'flex cursor-pointer items-baseline gap-3 px-2 py-1.5',
            index === active && 'bg-accent text-accent-foreground',
          )}
          onMouseEnter={() => {
            setActive(index)
          }}
          onMouseDown={(e) => {
            e.preventDefault()
            onPick(target)
          }}
        >
          <span className="w-16 shrink-0 text-muted-foreground" title={new Date(target.created_at).toLocaleString()}>
            {relativeTime(target.created_at)}
          </span>
          <span className="min-w-0 flex-1 truncate">{firstLine(target.text)}</span>
        </div>
      ))}
    </div>
  )
}

function filesNote(preview: RewindFilesPreview | null): string {
  if (preview === null) {
    return 'Checking file checkpoints...'
  }
  if (!preview.can_rewind) {
    return `Code cannot be restored: ${preview.error ?? 'no file checkpoint for this prompt'}`
  }
  if (preview.files.length === 0) {
    return 'No file edits to undo since this prompt.'
  }
  const names = preview.files.map((file) => file.split('/').at(-1) ?? file).join(', ')
  const count = preview.files.length === 1 ? '1 file' : `${String(preview.files.length)} files`
  return `Restoring code puts back ${count} (+${String(preview.insertions)} -${String(preview.deletions)}): ${names}`
}

const unavailable = (e: unknown): RewindFilesPreview => ({
  can_rewind: false,
  error: errorText(e),
  files: [],
  insertions: 0,
  deletions: 0,
})

function RestoreChoice({
  taskId,
  target,
  busy,
  onChoose,
  onBack,
}: {
  taskId: string
  target: RewindTarget
  busy: boolean
  onChoose: (restore: RewindRestore) => void
  onBack: () => void
}) {
  const [preview, setPreview] = useState<RewindFilesPreview | null>(null)
  const primary = useRef<HTMLButtonElement>(null)
  const code = preview !== null && preview.can_rewind && preview.files.length > 0

  useEffect(() => {
    primary.current?.focus()
    let current = true
    apiGet<RewindFilesPreview>(`/tasks/${taskId}/rewind/files?message_id=${String(target.message_id)}`)
      .catch(unavailable)
      .then((result) => {
        if (current) {
          setPreview(result)
        }
      })
      .catch(() => undefined)
    return () => {
      current = false
    }
  }, [taskId, target.message_id])

  return (
    <>
      <div className="space-y-2">
        <p className="text-muted-foreground">Rewind to just before this prompt:</p>
        <blockquote className="max-h-32 overflow-y-auto border-l-2 border-primary/50 bg-primary/5 px-3 py-2 whitespace-pre-wrap">
          {target.text}
        </blockquote>
        <p className="text-muted-foreground">
          Restoring the conversation drops this prompt and everything after it ({messages(target.message_count)}) from
          the agent&apos;s context; the transcript keeps them, folded. The prompt goes back into the reply box.
        </p>
        <p role="status" aria-label="Code restore" className="text-muted-foreground">
          {filesNote(preview)}
        </p>
      </div>
      <DialogFooter className="sm:justify-between">
        <Button variant="ghost" size="sm" onClick={onBack} disabled={busy}>
          <ArrowLeft />
          Back
        </Button>
        <div className="flex flex-col-reverse gap-2 sm:flex-row">
          <Hint text="Put the files back; the agent keeps the conversation">
            <Button
              variant="outline"
              size="sm"
              aria-label="Restore code"
              disabled={busy || !code}
              onClick={() => {
                onChoose('code')
              }}
            >
              <FileCode />
              Code
            </Button>
          </Hint>
          <Hint text="Put the files back and rewind the conversation">
            <Button
              variant="outline"
              size="sm"
              aria-label="Restore both"
              disabled={busy || !code}
              onClick={() => {
                onChoose('both')
              }}
            >
              <Layers />
              Both
            </Button>
          </Hint>
          <Hint text="Rewind the conversation; the files stay as they are">
            <Button
              ref={primary}
              size="sm"
              aria-label="Restore conversation"
              disabled={busy}
              onClick={() => {
                onChoose('conversation')
              }}
            >
              <MessageSquare />
              Conversation
            </Button>
          </Hint>
        </div>
      </DialogFooter>
    </>
  )
}

/** Double Esc: pick an earlier prompt, then what to put back to how it was before it. */
export function RewindDialog({
  taskId,
  onClose,
  onRewound,
}: {
  taskId: string
  onClose: () => void
  onRewound: (result: RewindResult) => void
}) {
  const [targets, setTargets] = useState<RewindTarget[] | null>(null)
  const [picked, setPicked] = useState<RewindTarget | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    apiGet<RewindTarget[]>(`/tasks/${taskId}/rewind/targets`)
      .then(setTargets)
      .catch((e: unknown) => {
        toast.error(errorText(e))
        setTargets([])
      })
  }, [taskId])

  const choose = async (restore: RewindRestore) => {
    if (picked === null) {
      return
    }
    setBusy(true)
    try {
      onRewound(await apiPost<RewindResult>(`/tasks/${taskId}/rewind`, { message_id: picked.message_id, restore }))
    } catch (e) {
      toast.error(errorText(e))
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) {
          onClose()
        }
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        className="gap-4 sm:max-w-lg"
        onOpenAutoFocus={(e) => {
          e.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History className="size-4" />
            Rewind
          </DialogTitle>
        </DialogHeader>
        <ErrorBoundary name="Rewind" kind="inline" resetKey={picked}>
          {picked === null ? (
            <TargetList targets={targets} onPick={setPicked} />
          ) : (
            <RestoreChoice
              taskId={taskId}
              target={picked}
              busy={busy}
              onChoose={(restore) => void choose(restore)}
              onBack={() => {
                setPicked(null)
              }}
            />
          )}
        </ErrorBoundary>
      </DialogContent>
    </Dialog>
  )
}
