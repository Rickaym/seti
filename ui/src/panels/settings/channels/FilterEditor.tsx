import {
  WEBHOOK_FILTER_API_DOC,
  WEBHOOK_FILTER_TEMPLATE,
  type WebhookChannelInfo,
  type WebhookFilterInput,
  type WebhookFilterTestInput,
  type WebhookFilterTestResult,
} from '@seti/shared'
import { FlaskConical } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { apiPost, apiPut, errorText } from '@/api'
import { Hint } from '@/components/Hint'
import { CodeEditor } from '@/components/code-editor/CodeEditor'
import { CrudEditDialog, Field } from '@/components/crud/CrudForm'
import { FindableTextarea } from '@/components/find/FindableTextarea'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { FilterTestView } from './FilterTestView'

/** A request to try besides the recent deliveries, as pasted from the sender's delivery log. */
function SampleFields({
  headers,
  body,
  onHeaders,
  onBody,
}: {
  headers: string
  body: string
  onHeaders: (value: string) => void
  onBody: (value: string) => void
}) {
  return (
    <details className="col-span-full border border-border p-2">
      <summary className="cursor-pointer font-medium">Sample</summary>
      <p className="mt-1 text-muted-foreground">
        Paste a request the app sent to try it too. Seti reads it as this webhook&apos;s sender would, without checking
        its signature.
      </p>
      <div className="mt-2 grid grid-cols-1 gap-2">
        <FindableTextarea
          aria-label="Sample headers"
          placeholder={'Content-Type: application/json\nX-GitHub-Event: check_run'}
          className="min-h-16 font-mono text-xs"
          spellCheck={false}
          value={headers}
          onChange={(e) => {
            onHeaders(e.target.value)
          }}
        />
        <FindableTextarea
          aria-label="Sample body"
          placeholder='{"type":"Issue","action":"create","data":{"title":"..."}}'
          className="min-h-24 font-mono text-xs"
          spellCheck={false}
          value={body}
          onChange={(e) => {
            onBody(e.target.value)
          }}
        />
      </div>
    </details>
  )
}

/** Writes, tests and saves the code that drops or reshapes a webhook's deliveries. */
export function FilterEditor({
  info,
  onClose,
  onSaved,
}: {
  info: WebhookChannelInfo
  onClose: () => void
  onSaved: (next: WebhookChannelInfo) => void
}) {
  const [script, setScript] = useState(info.filter?.script ?? WEBHOOK_FILTER_TEMPLATE)
  const [enabled, setEnabled] = useState(info.filter?.enabled ?? true)
  const [headers, setHeaders] = useState('')
  const [body, setBody] = useState('')
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<WebhookFilterTestResult | null>(null)

  const save = async () => {
    setSaving(true)
    try {
      const input: WebhookFilterInput = { script, enabled: script.trim() !== '' && enabled }
      onSaved(await apiPut<WebhookChannelInfo>(`/channels/${info.id}/filter`, input))
      onClose()
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setSaving(false)
    }
  }

  const test = async () => {
    setTesting(true)
    try {
      const input: WebhookFilterTestInput = { script, ...(body.trim() === '' ? {} : { sample: { headers, body } }) }
      setResult(await apiPost<WebhookFilterTestResult>(`/channels/${info.id}/filter/test`, input))
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
      title={`Filter for ${info.name}`}
      onCancel={onClose}
      onSave={() => void save()}
      saving={saving}
    >
      <p className="col-span-full text-muted-foreground">
        Runs on each verified delivery before any subscriber gets it. Return false to drop it, true to keep it, or an
        object to change its event, title, link or detail. Clear the code and save to remove the filter.
      </p>
      <Field label="Code" full>
        <CodeEditor label="Filter code" className="min-h-56" value={script} onChange={setScript} />
      </Field>
      <details className="col-span-full border border-border p-2">
        <summary className="cursor-pointer font-medium">Filter API</summary>
        <pre className="mt-2 text-2xs leading-relaxed whitespace-pre-wrap text-muted-foreground">
          {WEBHOOK_FILTER_API_DOC}
        </pre>
      </details>
      <SampleFields headers={headers} body={body} onHeaders={setHeaders} onBody={setBody} />
      <div className="col-span-full flex flex-wrap items-center justify-between gap-3">
        <Hint text="Run the code as edited on recent deliveries and the sample; nothing is stored or sent">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={testing || script.trim() === ''}
            onClick={() => void test()}
          >
            <FlaskConical />
            {testing ? 'Testing...' : 'Test'}
          </Button>
        </Hint>
        <div className="flex items-center gap-2">
          <Switch aria-label="Filter on" checked={enabled} onCheckedChange={setEnabled} />
          <span aria-hidden>On</span>
        </div>
      </div>
      {result !== null && <FilterTestView result={result} />}
    </CrudEditDialog>
  )
}
