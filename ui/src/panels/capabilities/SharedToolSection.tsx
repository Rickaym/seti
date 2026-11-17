import type { SharedTool, SharedToolCode } from '@seti/shared'
import { Code } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { apiDelete, apiGet, apiPatch, errorText } from '@/api'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { useConfirm } from '@/components/ui/confirm-context'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import { DeleteIconButton } from '@/components/ui/table-action-buttons'
import { relativeTime } from '@/lib/time'
import { ScriptCode, ToolNeeds } from '@/panels/tasks/SharedToolProposal'
import { EmptyRow, Section } from './Section'
import { matches } from './filter'

const HASH_CHARS = 12

function CodeDialog({ name, onClose }: { name: string; onClose: () => void }) {
  const [tool, setTool] = useState<SharedToolCode | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    apiGet<SharedToolCode>(`/shared-tools/${name}`, controller.signal)
      .then(setTool)
      .catch((e: unknown) => {
        if (!controller.signal.aborted) {
          setError(errorText(e))
        }
      })
    return () => {
      controller.abort()
    }
  }, [name])

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose()
        }
      }}
    >
      <DialogContent className="flex max-h-[92vh] min-h-0 flex-col gap-2 overflow-hidden sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Code of {name}</DialogTitle>
        </DialogHeader>
        {error !== '' && <p className="text-xs text-destructive">{error}</p>}
        {tool === null && error === '' && <p className="text-xs text-muted-foreground">Reading the code...</p>}
        {tool !== null && (
          <div className="flex min-h-0 flex-col gap-1.5 overflow-auto text-xs">
            <p className="break-all text-muted-foreground">
              {tool.file}, sha256 <code className="font-mono">{tool.sha256}</code>
            </p>
            <ScriptCode name={tool.name} content={tool.content} />
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

interface RowProps {
  tool: SharedTool
  onChanged: () => void
  onView: () => void
}

function ToolRow({ tool, onChanged, onView }: RowProps) {
  const confirm = useConfirm()
  const [busy, setBusy] = useState(false)

  const run = async (action: () => Promise<unknown>, done: string) => {
    setBusy(true)
    try {
      await action()
      toast.success(done)
      onChanged()
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    const message =
      `Agents lose the skill ${tool.name} from their next turn, and its code is deleted from Seti. ` +
      'Only a new proposal that you allow brings it back.'
    if (!(await confirm({ title: `Remove ${tool.name}`, message, confirmLabel: 'Remove', variant: 'destructive' }))) {
      return
    }
    await run(async () => apiDelete(`/shared-tools/${tool.name}`), `Removed ${tool.name}`)
  }

  const state = tool.enabled
    ? "On: agents that qualify get it. Turning it off applies from each agent's next turn."
    : "Off: no agent gets it. Turning it on applies from each agent's next turn."
  return (
    <li data-shared-tool={tool.name} className="flex flex-wrap items-start gap-x-3 gap-y-2 px-3 py-2">
      <div className="flex min-w-0 flex-1 basis-64 flex-col gap-1">
        <span className="font-mono font-semibold break-all">{tool.name}</span>
        <p className="break-words whitespace-pre-wrap text-muted-foreground">{tool.description}</p>
        <ToolNeeds needs={tool.needs} />
        <p className="text-2xs break-all text-muted-foreground" title={tool.sha256}>
          Proposed by {tool.proposer_title} {relativeTime(tool.updated_at)}, sha256{' '}
          <code className="font-mono">{tool.sha256.slice(0, HASH_CHARS)}</code>
        </p>
      </div>
      <span className="flex shrink-0 items-center gap-2">
        <Hint text="Read the script agents run">
          <Button type="button" variant="outline" size="xs" aria-label={`Code of ${tool.name}`} onClick={onView}>
            <Code />
            Code
          </Button>
        </Hint>
        <Hint text={state} side="left">
          <span className="flex shrink-0 items-center gap-1.5 text-2xs text-muted-foreground">
            On
            <Switch
              aria-label={`${tool.name} on`}
              checked={tool.enabled}
              disabled={busy}
              onCheckedChange={(enabled) =>
                void run(
                  async () => apiPatch<SharedTool>(`/shared-tools/${tool.name}`, { enabled }),
                  `${tool.name} is ${enabled ? 'on' : 'off'}`,
                )
              }
            />
          </span>
        </Hint>
        <DeleteIconButton aria-label={`Remove ${tool.name}`} loading={busy} onClick={() => void remove()} />
      </span>
    </li>
  )
}

/** The scripts agents proposed and the user allowed, with each one's code, switch and removal. */
export function SharedToolSection({ query, refreshToken }: { query: string; refreshToken: number }) {
  const [tools, setTools] = useState<SharedTool[] | null>(null)
  const [error, setError] = useState('')
  const [viewing, setViewing] = useState<string | null>(null)
  const [n, setN] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    apiGet<SharedTool[]>('/shared-tools', controller.signal)
      .then((next) => {
        setTools(next)
        setError('')
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted) {
          setError(errorText(e))
        }
      })
    return () => {
      controller.abort()
    }
  }, [refreshToken, n])

  const reload = useCallback(() => {
    setN((value) => value + 1)
  }, [])

  const rows = (tools ?? []).filter((tool) => matches(query, tool.name, tool.description))
  return (
    <Section title="Shared tools" count={rows.length}>
      <p className="border-b border-border px-3 py-1.5 text-muted-foreground">
        Scripts agents proposed and you allowed. Each loads as a skill into every sandboxed agent whose credential has
        the variables it needs, and runs with that agent&apos;s own access. Agents without the sandbox never get them.
        Turning one off or removing it applies from each agent&apos;s next turn.
      </p>
      {error !== '' && <p className="border-b border-border px-3 py-2 text-destructive">{error}</p>}
      {tools !== null && rows.length === 0 && (
        <EmptyRow>{query === '' ? 'No shared tools. Agents propose them with request_change.' : 'No match.'}</EmptyRow>
      )}
      <ul className="divide-y divide-border">
        {rows.map((tool) => (
          <ToolRow
            key={tool.name}
            tool={tool}
            onChanged={reload}
            onView={() => {
              setViewing(tool.name)
            }}
          />
        ))}
      </ul>
      {viewing !== null && (
        <CodeDialog
          name={viewing}
          onClose={() => {
            setViewing(null)
          }}
        />
      )}
    </Section>
  )
}
