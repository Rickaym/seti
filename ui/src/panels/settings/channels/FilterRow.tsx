import {
  WEBHOOK_FILTER_LIMITS,
  type ChannelInfo,
  type WebhookChannelInfo,
  type WebhookFilterInfo,
  type WebhookFilterInput,
} from '@seti/shared'
import { Funnel, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { apiPut, errorText } from '@/api'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { SettingRow } from '../layout'
import { FilterEditor } from './FilterEditor'

/** What the filter did in the last 24 hours, leaving out outcomes that did not happen. */
function dayText({ day }: WebhookFilterInfo): string {
  const counts = [
    `${String(day.kept)} kept`,
    ...(day.changed > 0 ? [`${String(day.changed)} changed`] : []),
    `${String(day.dropped)} dropped`,
    ...(day.failed > 0 ? [`${String(day.failed)} failed`] : []),
  ]
  return `Last 24 hours: ${counts.join(', ')}`
}

function Summary({ filter }: { filter: WebhookFilterInfo | null }) {
  if (filter === null) {
    return <>Every delivery goes to the subscribers. Add code to drop or reshape some first.</>
  }
  const failing = filter.failures >= WEBHOOK_FILTER_LIMITS.failuresBeforeWarning
  return (
    <>
      <span data-testid="filter-counts">
        {filter.enabled ? dayText(filter) : 'Off: every delivery goes on unchanged.'}
      </span>
      {failing && (
        <span role="status" className="mt-1 flex items-start gap-1 break-words text-warning-text">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          Failed its last {filter.failures} runs, so those deliveries went on unchanged: {filter.last_error}
        </span>
      )}
    </>
  )
}

/** A webhook's filter: what it did today, a switch, and the editor with its test. */
export function FilterRow({ info, onChange }: { info: WebhookChannelInfo; onChange: (next: ChannelInfo) => void }) {
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const { filter } = info
  const toggle = async (enabled: boolean) => {
    if (filter === null) {
      return
    }
    setBusy(true)
    try {
      const input: WebhookFilterInput = { script: filter.script, enabled }
      onChange(await apiPut<WebhookChannelInfo>(`/channels/${info.id}/filter`, input))
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <SettingRow label="Filter" stack description={<Summary filter={filter} />}>
      {filter !== null && (
        <Switch
          aria-label={`${info.name} filter on`}
          checked={filter.enabled}
          disabled={busy}
          onCheckedChange={(enabled) => void toggle(enabled)}
        />
      )}
      <Hint text="Code that drops or reshapes deliveries before subscribers get them">
        <Button
          size="xs"
          variant="outline"
          onClick={() => {
            setEditing(true)
          }}
        >
          <Funnel />
          {filter === null ? 'Add' : 'Edit'}
        </Button>
      </Hint>
      {editing && (
        <FilterEditor
          info={info}
          onClose={() => {
            setEditing(false)
          }}
          onSaved={onChange}
        />
      )}
    </SettingRow>
  )
}
