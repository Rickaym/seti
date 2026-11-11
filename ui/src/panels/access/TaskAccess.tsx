import {
  awsOutcomeLine,
  SETI_CONTROL_HINTS,
  SETI_CONTROL_LABELS,
  type AccessItem,
  type AwsOutcome,
  type SetiControlLevel,
  type Task,
  type TaskAccessInput,
  type TaskAccessView,
} from '@seti/shared'
import { Pencil, Search, type LucideIcon } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { apiPut, errorText } from '@/api'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { Hint } from '@/components/Hint'
import { InfoTip } from '@/components/InfoTip'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { McpAuthDialog } from '@/panels/capabilities/McpAuthDialog'
import { TaskCredentials } from '@/panels/tasks/TaskProfile'
import { AccessList, KIND_ICONS } from './AccessList'
import { SETI_CONTROL_ICONS, SetiControlRow } from './SetiControl'
import { TaskHostsRow } from './TaskHosts'
import { mcpBroken, noteAccessChange, useTaskAccess } from './access'

const APPLIES = 'Applies from the next turn'

/** Off is least privilege, so it reads muted; broken means on but not working, as without a key. */
type ChipState = 'on' | 'off' | 'broken'

interface Chip {
  key: string
  icon: LucideIcon
  label: string
  state: ChipState
  hint: string
}

const CHIP_TONE: Record<ChipState, string> = {
  on: 'border-border text-foreground',
  off: 'border-border/60 text-muted-foreground',
  broken: 'border-warning/60 bg-warning/10 text-foreground',
}

function chipState(enabled: number, broken: number): ChipState {
  if (enabled === 0) {
    return 'off'
  }
  return broken > 0 ? 'broken' : 'on'
}

function sshChip(items: readonly AccessItem[]): Chip {
  const enabled = items.filter((item) => item.kind === 'ssh' && item.enabled)
  const names = enabled.map((item) => item.name)
  const blocked = enabled.filter((item) => item.missing_key.length > 0).map((item) => item.name)
  const hint = names.length === 0 ? 'No SSH hosts' : `SSH to ${names.join(', ')}`
  return {
    key: 'ssh',
    icon: KIND_ICONS.ssh,
    label: names.length === 0 ? 'SSH' : `SSH ${names.join(', ')}`,
    state: chipState(names.length, blocked.length),
    hint: blocked.length === 0 ? hint : `${hint}; no key for ${blocked.join(', ')}`,
  }
}

function mcpChip(items: readonly AccessItem[]): Chip {
  const enabled = items.filter((item) => item.kind === 'mcp' && item.enabled)
  const broken = enabled.filter(mcpBroken).map((item) => item.name)
  const hint = `${String(enabled.length)} MCP servers on`
  return {
    key: 'mcp',
    icon: KIND_ICONS.mcp,
    label: enabled.length === 0 ? 'MCP' : `${String(enabled.length)} MCP`,
    state: chipState(enabled.length, broken.length),
    hint: broken.length === 0 ? hint : `${hint}; not working in the latest session: ${broken.join(', ')}`,
  }
}

const setiChip = (level: SetiControlLevel): Chip => ({
  key: 'seti',
  icon: SETI_CONTROL_ICONS[level],
  label: level === 'off' ? 'Seti' : `Seti ${SETI_CONTROL_LABELS[level]}`,
  state: level === 'off' ? 'off' : 'on',
  hint: `Seti control ${SETI_CONTROL_LABELS[level]}: ${SETI_CONTROL_HINTS[level].toLowerCase()}`,
})

/** Unsandboxed, AWS is the host's own; on without a role in the set, it does not work. */
function awsChipState(aws: AwsOutcome, enabled: number): ChipState {
  if (aws.state === 'host') {
    return 'on'
  }
  return chipState(enabled, aws.state === 'no_role' ? 1 : 0)
}

function chips({ items, aws }: TaskAccessView): Chip[] {
  const on = (kind: AccessItem['kind']) => items.filter((item) => item.kind === kind && item.enabled)
  const count = (kind: AccessItem['kind'], label: string, noun: string): Chip => {
    const n = on(kind).length
    const shown = n === 1 ? label.replace(/s$/u, '') : label
    return {
      key: kind,
      icon: KIND_ICONS[kind],
      label: n === 0 ? label : `${String(n)} ${shown}`,
      state: chipState(n, 0),
      hint: `${String(n)} ${noun} on`,
    }
  }
  return [
    sshChip(items),
    {
      key: 'aws',
      icon: KIND_ICONS.aws,
      label: 'AWS',
      state: awsChipState(aws, on('aws').length),
      hint: awsOutcomeLine(aws),
    },
    mcpChip(items),
    count('pack', 'packs', 'context packs'),
    count('plugin', 'plugins', 'plugins'),
  ]
}

function CredentialsRow({ task, onChanged }: { task: Task; onChanged: () => void }) {
  return (
    <section aria-label="Credentials" className="flex flex-wrap items-center gap-2 text-xs">
      <span className="text-2xs font-medium text-muted-foreground">Credentials</span>
      <TaskCredentials task={task} onChanged={onChanged} />
    </section>
  )
}

/** The agent's access at a glance in its details: what is on, muted what is off. */
export function AccessSummary({ taskId, onOpen }: { taskId: string; onOpen: () => void }) {
  const { view } = useTaskAccess(taskId)
  return (
    <div className="flex min-w-0 items-start gap-1">
      {view === null ? (
        <span className="text-muted-foreground">Loading...</span>
      ) : (
        <ul aria-label="Access" className="flex min-w-0 flex-1 flex-wrap gap-1">
          {[...chips(view), setiChip(view.seti_control)].map((chip) => {
            const Icon = chip.icon
            return (
              <li key={chip.key} className="min-w-0">
                <Hint text={chip.hint}>
                  <span
                    data-on={chip.state === 'on'}
                    data-state={chip.state}
                    className={cn(
                      'flex max-w-56 items-center gap-1 border px-1.5 py-px text-2xs',
                      CHIP_TONE[chip.state],
                    )}
                  >
                    <Icon className="size-3 shrink-0" aria-hidden />
                    <span className="truncate">{chip.label}</span>
                  </span>
                </Hint>
              </li>
            )
          })}
        </ul>
      )}
      <Hint text="Edit access">
        <Button size="sm" variant="outline" aria-label="Edit access" className="shrink-0" onClick={onOpen}>
          <Pencil />
          Edit
        </Button>
      </Hint>
    </div>
  )
}

/**
 * Everything the agent may reach: each item follows the default for every agent or this agent's
 * own choice. A change restarts the session at the next turn.
 */
export function TaskAccessDialog({
  task,
  onChanged,
  onClose,
}: {
  task: Task
  onChanged: () => void
  onClose: () => void
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [signIn, setSignIn] = useState<string | null>(null)
  const { view, setView, load } = useTaskAccess(task.id, task.profile_id)

  const [bulk, setBulk] = useState(false)

  const setAll = async (items: readonly AccessItem[], enabled: boolean) => {
    setBulk(true)
    try {
      for (const item of items.filter((candidate) => candidate.enabled !== enabled)) {
        const body: TaskAccessInput = { kind: item.kind, id: item.id, enabled }
        setView(await apiPut<TaskAccessView>(`/tasks/${task.id}/access`, body))
      }
      noteAccessChange(task.id)
      toast.success(APPLIES)
    } catch (e) {
      toast.error(errorText(e))
      load()
    } finally {
      setBulk(false)
    }
  }

  const change = async (item: AccessItem, enabled: boolean | null) => {
    setBusy(`${item.kind}:${item.id}`)
    try {
      const body: TaskAccessInput = { kind: item.kind, id: item.id, enabled }
      setView(await apiPut<TaskAccessView>(`/tasks/${task.id}/access`, body))
      noteAccessChange(task.id)
      toast.success(APPLIES)
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) {
          onClose()
        }
      }}
    >
      <DialogContent
        className="flex max-h-[85dvh] flex-col gap-3 overflow-hidden sm:max-w-lg md:max-w-3xl max-md:overflow-hidden"
        aria-describedby={undefined}
      >
        <DialogHeader>
          <DialogTitle className="truncate">Access of {task.title}</DialogTitle>
        </DialogHeader>
        <p className="-mt-1 flex flex-wrap items-center gap-1.5 text-2xs text-muted-foreground">
          Applies next turn.
          {view?.sandboxed === false && ' SSH, AWS and credentials need the sandbox.'}
          <InfoTip
            label="About access"
            text="Each item follows its default unless this agent has its own choice. Changes apply from the next turn."
          />
        </p>
        <CredentialsRow task={task} onChanged={onChanged} />
        {view !== null && (
          <SetiControlRow
            task={task}
            level={view.seti_control}
            onSaved={(level) => {
              setView({ ...view, seti_control: level })
              onChanged()
            }}
          />
        )}
        {view !== null && view.hosts.length > 0 && (
          <TaskHostsRow
            taskId={task.id}
            hosts={view.hosts}
            onChanged={(hosts) => {
              setView({ ...view, hosts })
            }}
          />
        )}
        <div className="relative shrink-0">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            aria-label="Search access"
            placeholder="Search hosts, servers, packs, plugins"
            className="pl-7"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
            }}
          />
        </div>
        <div className="-mx-4 min-h-0 flex-1 overflow-y-auto px-4 pb-1">
          {view === null ? (
            <p className="text-muted-foreground">Loading...</p>
          ) : (
            <ErrorBoundary name="Access" kind="inline">
              <AccessList
                items={view.items}
                query={query}
                busy={busy}
                frozen={bulk}
                profile={view.profile}
                columns={2}
                onChange={(item, enabled) => void change(item, enabled)}
                onSetAll={(items, enabled) => void setAll(items, enabled)}
                onSignIn={(item) => {
                  setSignIn(item.name)
                }}
              />
            </ErrorBoundary>
          )}
        </div>
      </DialogContent>
      {signIn !== null && (
        <McpAuthDialog
          serverName={signIn}
          repoId={undefined}
          taskId={task.id}
          onClose={() => {
            setSignIn(null)
          }}
          onDone={() => {
            toast.success(`Signed in to ${signIn}; the next turn connects with it`)
            load()
          }}
        />
      )}
    </Dialog>
  )
}
