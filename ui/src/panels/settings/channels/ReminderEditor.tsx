import {
  REMINDER_API_DOC,
  REMINDER_LIMITS,
  REMINDER_TEMPLATE,
  type ChannelInfo,
  type CronSchedule,
  type ReminderChannelInfo,
  type ReminderCreateInput,
  type ReminderTestInput,
  type ReminderTestResult,
  type ReminderUpdateInput,
} from '@seti/shared'
import { CalendarClock, FlaskConical, Plus, Save } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { apiPost, apiPut, errorText } from '@/api'
import { Hint } from '@/components/Hint'
import { CodeEditor } from '@/components/code-editor/CodeEditor'
import { CrudEditDialog, Field } from '@/components/crud/CrudForm'
import { CronFields } from '@/components/schedule/CronFields'
import { browserTimezone, DEFAULT_CRON } from '@/components/schedule/cron'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { INTERVAL_UNITS, splitInterval, type IntervalUnit } from './interval'

const isUnit = (value: string): value is IntervalUnit => Object.hasOwn(INTERVAL_UNITS, value)

interface Draft {
  name: string
  script: string
  every: string
  unit: IntervalUnit
  /** Runs on the cron schedule instead of the interval. */
  onCron: boolean
  schedule: CronSchedule
  subscribeEa: boolean
}

function draftOf(editing: ReminderChannelInfo | null): Draft {
  const { count, unit } = splitInterval(editing?.reminder.interval_s ?? REMINDER_LIMITS.intervalDefaultS)
  return {
    name: editing?.name ?? '',
    script: editing?.reminder.script ?? REMINDER_TEMPLATE,
    every: String(count),
    unit,
    onCron: (editing?.reminder.schedule ?? null) !== null,
    schedule: editing?.reminder.schedule ?? { cron: DEFAULT_CRON, timezone: browserTimezone() },
    subscribeEa: false,
  }
}

const intervalOf = (draft: Draft) => Math.round(Number(draft.every) * INTERVAL_UNITS[draft.unit].seconds)

const OUTCOME_TEXT: Record<ReminderTestResult['outcome'], string> = {
  ok: 'Would deliver',
  empty: 'Nothing to deliver this time',
  error: 'Failed',
  timeout: 'Timed out',
}

/** What a test run returned: the message it would deliver, or why it failed, and its log. */
function TestView({ result }: { result: ReminderTestResult }) {
  const failed = result.outcome === 'error' || result.outcome === 'timeout'
  const seconds = (result.duration_ms / 1000).toFixed(1)
  return (
    <section aria-label="Test run result" className="col-span-full space-y-2 border border-border p-2">
      <p className={cn('font-medium', failed && 'text-destructive')} data-testid="reminder-test-status">
        {OUTCOME_TEXT[result.outcome]} in {seconds} s{failed ? `: ${result.error ?? 'unknown error'}` : ''}
      </p>
      {result.message !== null && (
        <pre aria-label="Message" className="bg-muted p-2 text-xs break-words whitespace-pre-wrap">
          {result.message}
        </pre>
      )}
      {result.state !== null && (
        <pre aria-label="State" className="max-h-24 overflow-auto bg-muted p-2 text-2xs break-all whitespace-pre-wrap">
          state: {JSON.stringify(result.state)}
        </pre>
      )}
      {result.logs.length > 0 && (
        <pre aria-label="Log" className="max-h-40 overflow-auto bg-muted p-2 text-2xs whitespace-pre-wrap">
          {result.logs.join('\n')}
        </pre>
      )}
    </section>
  )
}

/** Creates or edits a reminder: its name, interval or cron schedule, and script, with a test run. */
export function ReminderEditor({
  editing,
  onClose,
  onSaved,
}: {
  /** The reminder to edit; null creates a new one. Mount it again for another reminder. */
  editing: ReminderChannelInfo | null
  onClose: () => void
  onSaved: (info: ChannelInfo) => void
}) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(editing))
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<ReminderTestResult | null>(null)

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }))
  }

  const save = async () => {
    setSaving(true)
    try {
      const settings = {
        name: draft.name,
        script: draft.script,
        interval_s: intervalOf(draft),
        schedule: draft.onCron ? draft.schedule : null,
      }
      if (editing === null) {
        const input: ReminderCreateInput = { ...settings, subscribe_ea: draft.subscribeEa }
        onSaved(await apiPost<ChannelInfo>('/channels/reminders', input))
      } else {
        const input: ReminderUpdateInput = settings
        onSaved(await apiPut<ChannelInfo>(`/channels/reminders/${editing.id}`, input))
      }
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setSaving(false)
    }
  }

  const test = async () => {
    setTesting(true)
    try {
      const input: ReminderTestInput = { script: draft.script, ...(editing === null ? {} : { channel_id: editing.id }) }
      setResult(await apiPost<ReminderTestResult>('/channels/reminders/test', input))
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setTesting(false)
    }
  }

  return (
    <CrudEditDialog
      open
      wide
      title={editing === null ? 'New reminder' : `Edit ${editing.name}`}
      onCancel={onClose}
      onSave={() => void save()}
      saving={saving}
      saveLabel={editing === null ? 'Create' : 'Save'}
      savingLabel={editing === null ? 'Creating...' : 'Saving...'}
      saveIcon={editing === null ? Plus : Save}
    >
      <Field label="Name">
        <Input
          aria-label="Name"
          placeholder="Standup nudge"
          value={draft.name}
          onChange={(e) => {
            set('name', e.target.value)
          }}
        />
      </Field>
      <Field label="Timing">
        <div className="flex h-8 items-center gap-2 text-xs text-muted-foreground">
          <Switch
            aria-label="Cron schedule"
            checked={draft.onCron}
            onCheckedChange={(checked) => {
              set('onCron', checked)
            }}
          />
          <CalendarClock className="size-3.5" aria-hidden />
          Cron
        </div>
      </Field>
      {draft.onCron ? (
        <CronFields
          value={draft.schedule}
          onChange={(schedule) => {
            set('schedule', schedule)
          }}
        />
      ) : (
        <Field label="Every">
          <div className="flex gap-2">
            <Input
              aria-label="Interval"
              type="number"
              min={1}
              className="w-24"
              value={draft.every}
              onChange={(e) => {
                set('every', e.target.value)
              }}
            />
            <NativeSelect
              aria-label="Interval unit"
              className="flex-1"
              value={draft.unit}
              onChange={(e) => {
                if (isUnit(e.target.value)) {
                  set('unit', e.target.value)
                }
              }}
            >
              {Object.entries(INTERVAL_UNITS).map(([id, unit]) => (
                <NativeSelectOption key={id} value={id}>
                  {unit.label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
        </Field>
      )}
      <Field label="Script" full>
        <CodeEditor
          label="Script"
          className="min-h-64"
          value={draft.script}
          onChange={(script) => {
            set('script', script)
          }}
        />
      </Field>
      <details className="col-span-full border border-border p-2">
        <summary className="cursor-pointer font-medium">Script API</summary>
        <pre className="mt-2 text-2xs leading-relaxed whitespace-pre-wrap text-muted-foreground">
          {REMINDER_API_DOC}
        </pre>
      </details>
      <div className="col-span-full flex items-center gap-2">
        <Hint text="Run the script once as edited; nothing is delivered or stored">
          <Button type="button" size="sm" variant="outline" disabled={testing} onClick={() => void test()}>
            <FlaskConical />
            {testing ? 'Testing...' : 'Test run'}
          </Button>
        </Hint>
      </div>
      {result !== null && <TestView result={result} />}
      {editing === null && (
        <div className="col-span-full flex items-center justify-between gap-3">
          <div>
            <div className="font-medium">EA delivery</div>
            <div className="text-muted-foreground">Subscribe the EA; agents subscribe from the channel card.</div>
          </div>
          <Switch
            aria-label="EA delivery"
            checked={draft.subscribeEa}
            onCheckedChange={(checked) => {
              set('subscribeEa', checked)
            }}
          />
        </div>
      )}
    </CrudEditDialog>
  )
}
