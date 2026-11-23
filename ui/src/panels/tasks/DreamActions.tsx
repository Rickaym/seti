import type { DreamRun, Revision } from '@seti/shared'
import { ChevronDown, Moon, Sparkles, Undo2 } from 'lucide-react'
import { useId, useState } from 'react'
import { Hint } from '@/components/Hint'
import { ToggleButton } from '@/components/ToggleButton'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { DreamProposals } from './DreamProposals'
import { useDreams, useNightly } from './useDreams'

const CONSEQUENCE = 'text-2xs text-muted-foreground'

const STATE_WORDS: Record<DreamRun['state'], string> = {
  planned: 'planned tonight',
  skipped: 'skipped',
  running: 'dreaming now',
  done: 'done',
  stopped: 'stopped',
  cut: 'cut short',
  failed: 'failed',
}

function ReportList({ title, items }: { title: string; items: readonly string[] }) {
  if (items.length === 0) {
    return null
  }
  return (
    <div className="grid gap-0.5">
      <p className="text-2xs font-medium">{title}</p>
      <ul className="grid list-disc gap-0.5 pl-4 text-2xs text-muted-foreground">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  )
}

function Changes({ changes, onUndo }: { changes: readonly Revision[]; onUndo: (revision: Revision) => void }) {
  return (
    <ul aria-label="Memory changes" className="grid gap-1">
      {changes.map((revision) => {
        const file = revision.object_id.slice(revision.object_id.indexOf(':') + 1)
        return (
          <li key={revision.id} className="flex items-center justify-between gap-2 text-2xs">
            <span className="min-w-0 truncate font-mono">{file}</span>
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
  )
}

function LastDream({
  run,
  changes,
  onUndo,
}: {
  run: DreamRun
  changes: readonly Revision[]
  onUndo: (r: Revision) => void
}) {
  const [open, setOpen] = useState(false)
  const report = run.report
  const line = `${STATE_WORDS[run.state]}, ${String(run.memory_changes)} memory ${run.memory_changes === 1 ? 'file' : 'files'} changed`
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="grid gap-1">
      <CollapsibleTrigger asChild>
        <Button variant="ghost" size="sm" className="justify-between" aria-label="Last dream">
          <span className="flex min-w-0 items-center gap-2">
            <Moon />
            <span className="truncate">{line}</span>
          </span>
          <ChevronDown className={open ? 'rotate-180' : ''} />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="grid gap-2 px-2 pb-1">
        <p className="text-2xs">{report?.summary ?? run.reason ?? 'No report yet.'}</p>
        <ReportList title="Tidied" items={report?.tidied ?? []} />
        <ReportList title="Remembered" items={report?.remembered ?? []} />
        <ReportList title="Asks" items={report?.asks ?? []} />
        <ReportList title="Found" items={report?.found ?? []} />
        {changes.length > 0 && <Changes changes={changes} onUndo={onUndo} />}
      </CollapsibleContent>
    </Collapsible>
  )
}

function nightlyHint(nightly: { enabled: boolean; on: boolean } | null): string {
  if (nightly?.on === false) {
    return 'Left out of nightly dreams; switch on to include it'
  }
  return nightly?.enabled === true
    ? 'Dreams each night it has something new; switch off to leave it out'
    : 'Dreams each night once Dreaming is on in Settings, Lifecycle'
}

/** Dream now, the agent's nightly switch, and the last dream's report with undo. */
export function DreamActions({ taskId, open }: { taskId: string; open: boolean }) {
  const id = useId()
  const { latest, changes, dreamNow, undo } = useDreams(taskId, open)
  const { nightly, switchTo } = useNightly(taskId, open)
  const dreaming = latest?.state === 'running'
  return (
    <div role="group" aria-label="Dreams" className="grid gap-1 border-b border-border pb-2">
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          className="flex-1 justify-start"
          disabled={dreaming}
          aria-describedby={id}
          onClick={dreamNow}
        >
          <Sparkles />
          {dreaming ? 'Dreaming' : 'Dream now'}
        </Button>
        <ToggleButton
          pressed={nightly?.on === true}
          disabled={nightly === null}
          onPressedChange={switchTo}
          icon={Moon}
          label="Nightly"
          hint={nightlyHint(nightly)}
        />
      </div>
      <p id={id} className={CONSEQUENCE}>
        Tidies its memory in a sandbox; changes nothing else
      </p>
      {latest !== null && <LastDream run={latest} changes={changes} onUndo={undo} />}
      <DreamProposals taskId={taskId} open={open} latest={`${String(latest?.id)}:${latest?.state ?? ''}`} />
    </div>
  )
}
