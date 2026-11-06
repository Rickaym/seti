import {
  WEBHOOK_MAPPING_FIELDS,
  type WebhookChannelInfo,
  type WebhookMapping,
  type WebhookMappingField,
} from '@seti/shared'
import { Save } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

const FIELDS: Record<WebhookMappingField, { label: string; placeholder: string }> = {
  title: { label: 'Title', placeholder: '/alert/title' },
  kind: { label: 'Kind', placeholder: '/alert/type' },
  severity: { label: 'Severity', placeholder: '/alert/level' },
  url: { label: 'URL', placeholder: '/alert/link' },
  subject: { label: 'Subject', placeholder: '/monitor/id' },
  state: { label: 'State', placeholder: '/monitor/status' },
}

/** JSON pointers that pick fields out of a generic payload before the best-effort mapping. */
export function MappingEditor({
  info,
  busy,
  onSave,
}: {
  info: WebhookChannelInfo
  busy: boolean
  onSave: (mapping: WebhookMapping) => void
}) {
  const [draft, setDraft] = useState<Partial<Record<string, string>>>({ ...info.mapping })
  const save = () => {
    const entries = Object.entries(draft).map(([key, pointer]) => [key, pointer?.trim() ?? ''] as const)
    onSave(Object.fromEntries(entries.filter(([, pointer]) => pointer !== '')))
  }
  return (
    <details className="border-t border-border px-3 py-2">
      <summary className="cursor-pointer font-medium">Field mapping</summary>
      <p className="mt-1 text-muted-foreground">
        JSON pointers into the payload. Empty fields use common names such as title, message, severity and url.
      </p>
      <div className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5">
        {WEBHOOK_MAPPING_FIELDS.map((field) => (
          <label key={field} className="contents">
            <span>{FIELDS[field].label}</span>
            <Input
              aria-label={`${FIELDS[field].label} pointer`}
              placeholder={FIELDS[field].placeholder}
              className="font-mono"
              value={draft[field] ?? ''}
              onChange={(e) => {
                setDraft({ ...draft, [field]: e.target.value })
              }}
            />
          </label>
        ))}
      </div>
      <div className="mt-2 flex justify-end">
        <Button size="xs" disabled={busy} onClick={save}>
          <Save />
          Save
        </Button>
      </div>
    </details>
  )
}
