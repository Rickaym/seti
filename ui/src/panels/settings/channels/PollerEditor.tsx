import {
  POLLER_API_DOC,
  POLLER_LIMITS,
  type ChannelInfo,
  type ChannelSources,
  type PollerChannelInfo,
  type PollerCreateInput,
  type PollerTemplateInfo,
  type PollerSettings,
  type PollerTestInput,
  type PollerTestResult,
  type PollerUpdateInput,
} from '@seti/shared'
import { FlaskConical, Plus, Save } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { apiGet, apiPost, apiPut, errorText } from '@/api'
import { Hint } from '@/components/Hint'
import { SettingsLink } from '@/components/SettingsLink'
import { CodeEditor } from '@/components/code-editor/CodeEditor'
import { CrudEditDialog, Field } from '@/components/crud/CrudForm'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { PollerTestView } from './PollerTestView'
import { useChannelSources } from './sources'

const listOf = (text: string) =>
  text
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')

interface Draft {
  name: string
  preset: string
  script: string
  intervalMin: string
  timeoutS: string
  hosts: string
  secrets: string[]
  fingerprint: string
  detectGone: boolean
  subscribeEa: boolean
}

const fresh = (): Draft => ({
  name: '',
  preset: '',
  script: '',
  intervalMin: String(POLLER_LIMITS.intervalDefaultS / 60),
  timeoutS: String(POLLER_LIMITS.timeoutDefaultS),
  hosts: '',
  secrets: [],
  fingerprint: '',
  detectGone: false,
  subscribeEa: false,
})

const draftOf = (name: string, settings: PollerSettings): Draft => ({
  name,
  preset: settings.preset,
  script: settings.script,
  intervalMin: String(settings.interval_s / 60),
  timeoutS: String(settings.timeout_s),
  hosts: settings.extra_hosts.join(', '),
  secrets: settings.secrets,
  fingerprint: settings.fingerprint_fields.join(', '),
  detectGone: settings.detect_gone,
  subscribeEa: false,
})

function settingsOf(draft: Draft) {
  return {
    script: draft.script,
    preset: draft.preset,
    interval_s: Math.round(Number(draft.intervalMin) * 60),
    timeout_s: Math.round(Number(draft.timeoutS)),
    extra_hosts: listOf(draft.hosts),
    secrets: draft.secrets,
    fingerprint_fields: listOf(draft.fingerprint),
    detect_gone: draft.detectGone,
  }
}

function SecretPicker({ chosen, onChange }: { chosen: string[]; onChange: (next: string[]) => void }) {
  const [available, setAvailable] = useState<string[] | null>(null)
  useEffect(() => {
    apiGet<string[]>('/channels/pollers/secrets').then(setAvailable, () => {
      setAvailable([])
    })
  }, [])
  const names = [...new Set([...(available ?? []), ...chosen])]
  if (available === null) {
    return <p className="text-muted-foreground">Loading...</p>
  }
  if (names.length === 0) {
    return (
      <p className="text-muted-foreground">
        No connections yet. Add one in <SettingsLink page="connections">Settings, Connections</SettingsLink>.
      </p>
    )
  }
  return (
    <ul aria-label="Secrets to expose" className="flex flex-wrap gap-x-4 gap-y-2">
      {names.map((name) => (
        <li key={name} className="flex items-center gap-2">
          <Checkbox
            id={`poller-secret-${name}`}
            checked={chosen.includes(name)}
            onCheckedChange={(checked) => {
              onChange(checked === true ? [...chosen, name] : chosen.filter((entry) => entry !== name))
            }}
          />
          <label htmlFor={`poller-secret-${name}`} className="font-mono">
            {name}
          </label>
        </li>
      ))}
    </ul>
  )
}

/** Creates or edits a poller: script, schedule, reach and change detection, with a test run. */
export function PollerEditor({
  open,
  editing,
  onClose,
  onSaved,
}: {
  open: boolean
  /** The poller to edit; null creates a new one. Mount it again for another poller. */
  editing: PollerChannelInfo | null
  onClose: () => void
  onSaved: (info: ChannelInfo) => void
}) {
  const [draft, setDraft] = useState<Draft>(() => (editing === null ? fresh() : draftOf(editing.name, editing.poller)))
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<PollerTestResult | null>(null)

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }))
  }

  const startFrom = useCallback((sources: ChannelSources) => {
    const first = sources.pollers.find((entry) => entry.mod !== null) ?? sources.pollers[0]
    setDraft((prev) =>
      prev.preset !== '' || first === undefined ? prev : { ...prev, preset: first.id, script: first.script },
    )
  }, [])
  const templates = useChannelSources(open && editing === null, startFrom)?.pollers ?? []
  const template = templates.find((entry) => entry.id === draft.preset)
  const pickPreset = (picked: PollerTemplateInfo) => {
    setDraft((prev) => ({ ...prev, preset: picked.id, script: picked.script }))
    setResult(null)
  }

  const save = async () => {
    setSaving(true)
    try {
      if (editing === null) {
        const input: PollerCreateInput = { name: draft.name, subscribe_ea: draft.subscribeEa, ...settingsOf(draft) }
        onSaved(await apiPost<ChannelInfo>('/channels/pollers', input))
      } else {
        const input: PollerUpdateInput = { name: draft.name, ...settingsOf(draft) }
        onSaved(await apiPut<ChannelInfo>(`/channels/pollers/${editing.id}`, input))
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
      const input: PollerTestInput = { ...settingsOf(draft), ...(editing === null ? {} : { channel_id: editing.id }) }
      setResult(await apiPost<PollerTestResult>('/channels/pollers/test', input))
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setTesting(false)
    }
  }

  return (
    <CrudEditDialog
      open={open}
      wide
      title={editing === null ? 'New poller' : `Edit ${editing.name}`}
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
          placeholder="Release feed"
          value={draft.name}
          onChange={(e) => {
            set('name', e.target.value)
          }}
        />
      </Field>
      {editing === null ? (
        <Field label="Template">
          <Select
            value={draft.preset}
            onValueChange={(value) => {
              const picked = templates.find((entry) => entry.id === value)
              if (picked !== undefined) {
                pickPreset(picked)
              }
            }}
          >
            <SelectTrigger aria-label="Template" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {templates.map((entry) => (
                <SelectItem key={entry.id} value={entry.id}>
                  {entry.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      ) : (
        <div />
      )}
      {editing === null && <p className="col-span-full text-muted-foreground">{template?.description}</p>}
      <Field label="Script" full>
        <CodeEditor
          label="Script"
          className="min-h-72"
          value={draft.script}
          onChange={(script) => {
            set('script', script)
          }}
        />
      </Field>
      <details className="col-span-full border border-border p-2">
        <summary className="cursor-pointer font-medium">Script API</summary>
        <pre className="mt-2 text-2xs leading-relaxed whitespace-pre-wrap text-muted-foreground">{POLLER_API_DOC}</pre>
      </details>
      <div className="col-span-full flex items-center gap-2">
        <Hint text="Run the script once as edited; nothing is stored or sent to subscribers">
          <Button type="button" size="sm" variant="outline" disabled={testing} onClick={() => void test()}>
            <FlaskConical />
            {testing ? 'Testing...' : 'Test run'}
          </Button>
        </Hint>
      </div>
      {result !== null && <PollerTestView result={result} />}
      <Field label="Every">
        <div className="flex items-center gap-2">
          <Input
            aria-label="Interval"
            type="number"
            min={POLLER_LIMITS.intervalMinS / 60}
            value={draft.intervalMin}
            onChange={(e) => {
              set('intervalMin', e.target.value)
            }}
          />
          <span className="text-muted-foreground">minutes</span>
        </div>
      </Field>
      <Field label="Timeout">
        <div className="flex items-center gap-2">
          <Input
            aria-label="Timeout"
            type="number"
            min={POLLER_LIMITS.timeoutMinS}
            max={POLLER_LIMITS.timeoutMaxS}
            value={draft.timeoutS}
            onChange={(e) => {
              set('timeoutS', e.target.value)
            }}
          />
          <span className="text-muted-foreground">seconds</span>
        </div>
      </Field>
      <Field label="Extra hosts" full>
        <Input
          aria-label="Extra hosts"
          placeholder="api.example.com, *.example.org"
          value={draft.hosts}
          onChange={(e) => {
            set('hosts', e.target.value)
          }}
        />
      </Field>
      <p className="col-span-full -mt-2 text-muted-foreground">
        Pollers reach the sandbox&apos;s allowed hosts plus these, never private or local addresses.
      </p>
      <Field label="Secrets" full>
        <SecretPicker
          chosen={draft.secrets}
          onChange={(next) => {
            set('secrets', next)
          }}
        />
      </Field>
      <Field label="Watched fields">
        <Hint text="Item fields whose change reports the item again as changed">
          <Input
            aria-label="Watched fields"
            placeholder="status, updated_at"
            value={draft.fingerprint}
            onChange={(e) => {
              set('fingerprint', e.target.value)
            }}
          />
        </Hint>
      </Field>
      <div className="flex items-center justify-between gap-3 self-end">
        <Hint text="Report items that a complete run no longer returns">
          <span className="font-medium">Report gone items</span>
        </Hint>
        <Switch
          aria-label="Report gone items"
          checked={draft.detectGone}
          onCheckedChange={(checked) => {
            set('detectGone', checked)
          }}
        />
      </div>
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
