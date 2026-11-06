import {
  autoArchiveInput,
  type ArchiveSweepResult,
  type AutoArchiveInput,
  type AutoArchiveSettings,
  type AutoArchiveStatus,
} from '@seti/shared'
import { Archive, Save } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { apiGet, apiPost, apiPut, errorText } from '@/api'
import { Button } from '@/components/ui/button'
import { useConfirm } from '@/components/ui/confirm-context'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { useLeaveGuard } from '@/hooks/useLeaveGuard'
import { refreshTaskLists } from '@/hooks/useTasks'
import { navigate } from '@/lib/route'
import { bytesLabel } from '@/panels/resources/format'
import { SettingRow, SettingsCard } from './layout'

const PREVIEW_DELAY_MS = 300
const TITLES_SHOWN = 5
const TITLE = 'Archive'

const agents = (count: number) => `${String(count)} ${count === 1 ? 'agent' : 'agents'}`

const DELETE_DAYS_DEFAULT = 30

interface Form {
  enabled: boolean
  days: string
  deleting: boolean
  deleteDays: string
}

const toForm = (settings: AutoArchiveSettings): Form => ({
  enabled: settings.enabled,
  days: String(settings.days),
  deleting: settings.delete_after_days !== null,
  deleteDays: String(settings.delete_after_days ?? DELETE_DAYS_DEFAULT),
})

function parsed(form: Form): AutoArchiveInput | null {
  const result = autoArchiveInput.safeParse({
    enabled: form.enabled,
    days: Number(form.days),
    delete_after_days: form.deleting ? Number(form.deleteDays) : null,
  })
  return result.success ? result.data : null
}

const sameForm = (a: Form, b: Form) =>
  a.enabled === b.enabled &&
  a.days === b.days &&
  a.deleting === b.deleting &&
  (!a.deleting || a.deleteDays === b.deleteDays)

const statusPath = (days?: number) =>
  days === undefined ? '/archive/settings' : `/archive/settings?days=${String(days)}`

function Preview({ preview }: { preview: AutoArchiveStatus['preview'] }) {
  if (preview.count === 0) {
    return <span>Nothing matches now.</span>
  }
  const shown = preview.tasks.slice(0, TITLES_SHOWN)
  const more = preview.count - shown.length
  return (
    <span>
      {agents(preview.count)} {preview.count === 1 ? 'matches' : 'match'} now:{' '}
      {shown.map((task, index) => (
        <span key={task.id}>
          {index > 0 && ', '}
          <a
            className="text-primary hover:underline"
            href={`#agents/${task.id}`}
            onClick={(event) => {
              event.preventDefault()
              navigate('agents', task.id)
            }}
          >
            {task.title}
          </a>
        </span>
      ))}
      {more > 0 && ` and ${String(more)} more`}.
    </span>
  )
}

function RuleRow({ form, invalid, onChange }: { form: Form; invalid: boolean; onChange: (next: Form) => void }) {
  return (
    <SettingRow
      label="Auto archive"
      stack
      description="Archives COMPLETE agents, whose linked PRs all merged or closed, once idle this long. Agents that are working, have updates waiting or were mentioned in the group chat since are left alone. Runs every hour."
    >
      <Switch
        aria-label="Auto archive"
        checked={form.enabled}
        onCheckedChange={(enabled) => {
          onChange({ ...form, enabled })
        }}
      />
      <Input
        aria-label="Days idle"
        type="number"
        inputMode="numeric"
        min={1}
        max={365}
        value={form.days}
        aria-invalid={invalid}
        onChange={(event) => {
          onChange({ ...form, days: event.target.value })
        }}
        className="w-16"
      />
      <span className="text-muted-foreground">days</span>
    </SettingRow>
  )
}

function DeleteRow({ form, expired, onChange }: { form: Form; expired: number; onChange: (next: Form) => void }) {
  const due = form.deleting && expired > 0 ? ` ${agents(expired)} would go at the next hourly sweep.` : ''
  return (
    <SettingRow
      label="Delete archived"
      stack
      description={`Deletes archived agents this long after archiving, with their transcript, packed folders and worktrees. Pinned agents and ones with uncommitted changes stay.${due}`}
    >
      <Switch
        aria-label="Delete archived agents"
        checked={form.deleting}
        onCheckedChange={(deleting) => {
          onChange({ ...form, deleting })
        }}
      />
      <Input
        aria-label="Days archived"
        type="number"
        inputMode="numeric"
        min={1}
        max={3650}
        disabled={!form.deleting}
        value={form.deleteDays}
        onChange={(event) => {
          onChange({ ...form, deleteDays: event.target.value })
        }}
        className="w-18"
      />
      <span className="text-muted-foreground">days</span>
    </SettingRow>
  )
}

/** Previews the rule for the days in the form as they change, a moment after typing stops. */
function usePreview(initial: AutoArchiveStatus, days: number | undefined) {
  const [status, setStatus] = useState(initial)
  useEffect(() => {
    const timer = setTimeout(() => {
      apiGet<AutoArchiveStatus>(statusPath(days)).then(setStatus, (e: unknown) => toast.error(errorText(e)))
    }, PREVIEW_DELAY_MS)
    return () => {
      clearTimeout(timer)
    }
  }, [days])
  return [status, setStatus] as const
}

function AutoArchiveForm({ initial }: { initial: AutoArchiveStatus }) {
  const confirm = useConfirm()
  const [saved, setSaved] = useState(initial.settings)
  const [form, setForm] = useState(() => toForm(initial.settings))
  const [busy, setBusy] = useState(false)
  const input = parsed(form)
  const dirty = !sameForm(form, toForm(saved))
  const [status, setStatus] = usePreview(initial, input?.days)
  useLeaveGuard(dirty)

  const save = async () => {
    if (input === null) {
      toast.error('Days must be whole numbers: 1 to 365 idle, 1 to 3650 archived')
      return
    }
    setBusy(true)
    try {
      const next = await apiPut<AutoArchiveStatus>('/archive/settings', input)
      setSaved(next.settings)
      setStatus(next)
      toast.success('Auto archive saved')
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const runNow = async () => {
    const message = `Archive ${agents(status.preview.count)} now? Each can be restored from the Archived list.`
    if (!(await confirm({ title: 'Archive now', message, confirmLabel: 'Archive' }))) {
      return
    }
    setBusy(true)
    try {
      const result = await apiPost<ArchiveSweepResult>('/archive/sweep')
      const failed = result.failed.length > 0 ? `; ${String(result.failed.length)} could not be archived` : ''
      toast.success(`Archived ${agents(result.archived.length)}${failed}`)
      refreshTaskLists()
      setStatus(await apiGet<AutoArchiveStatus>(statusPath()))
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const { archived } = status
  return (
    <SettingsCard
      title={TITLE}
      actions={
        <Button size="sm" onClick={() => void save()} disabled={!dirty || busy}>
          <Save />
          Save
        </Button>
      }
    >
      <RuleRow form={form} invalid={input === null} onChange={setForm} />
      <DeleteRow form={form} expired={status.expired} onChange={setForm} />
      <SettingRow label="Due now" stack description={<Preview preview={status.preview} />}>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || dirty || status.preview.count === 0}
          onClick={() => void runNow()}
        >
          <Archive />
          Archive now
        </Button>
      </SettingRow>
      {archived.count > 0 && (
        <SettingRow
          label="Archived agents"
          description={`${agents(archived.count)}, ${bytesLabel(archived.table_bytes)} of transcript stored as ${bytesLabel(archived.stored_bytes)}, their folders packed into ${bytesLabel(archived.files_bytes)}. The Archived toggle of the agent list shows them.`}
        >
          {null}
        </SettingRow>
      )}
    </SettingsCard>
  )
}

/** The auto-archive rule: on or off, its days, what it would take now, and a way to run it. */
export function AutoArchiveCard() {
  const [status, setStatus] = useState<AutoArchiveStatus | null>(null)
  useEffect(() => {
    apiGet<AutoArchiveStatus>(statusPath()).then(setStatus, (e: unknown) => toast.error(errorText(e)))
  }, [])
  if (status === null) {
    return (
      <SettingsCard title={TITLE}>
        <p className="p-3 text-muted-foreground">Loading...</p>
      </SettingsCard>
    )
  }
  return <AutoArchiveForm initial={status} />
}
