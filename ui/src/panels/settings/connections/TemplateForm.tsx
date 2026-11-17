import {
  expandTemplate,
  type Connection,
  type ConnectionTemplate,
  type ConnectionTemplateField,
  type ConnectionTemplateInput,
  type TemplateTaken,
} from '@seti/shared'
import { ExternalLink, Pencil, Plus } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { apiPost, errorText } from '@/api'
import { CrudEditDialog, Field } from '@/components/crud/CrudForm'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { CredentialSwitches } from './CredentialSwitches'
import { ValueInput } from './ValueInput'
import { useCredentialList } from './use-credential-list'

const toggled = (set: ReadonlySet<string>, id: string, on: boolean): ReadonlySet<string> => {
  const next = new Set(set)
  if (on) {
    next.add(id)
  } else {
    next.delete(id)
  }
  return next
}

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: ConnectionTemplateField
  value: string
  onChange: (value: string) => void
}) {
  return (
    <Field label={field.label} full>
      {field.slot === null ? (
        <Input
          aria-label={field.label}
          className="font-mono"
          autoComplete="off"
          spellCheck={false}
          placeholder={field.placeholder}
          value={value}
          onChange={(event) => {
            onChange(event.target.value)
          }}
        />
      ) : (
        <ValueInput
          slot={field.slot}
          label={field.label}
          value={value}
          placeholder={field.placeholder}
          onChange={onChange}
        />
      )}
      <span className="text-2xs text-muted-foreground">{field.help}</span>
    </Field>
  )
}

function Parts({
  template,
  chosen,
  writes,
  onToggle,
  onWrite,
}: {
  template: ConnectionTemplate
  chosen: ReadonlySet<string>
  writes: ReadonlySet<string>
  onToggle: (id: string, on: boolean) => void
  onWrite: (id: string, on: boolean) => void
}) {
  return (
    <Field label="APIs" full>
      <ul aria-label="APIs" className="border border-border">
        {template.parts.map((part) => (
          <li key={part.id} className="flex items-center gap-3 border-b border-border px-3 py-2 last:border-b-0">
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-sm">{part.title}</span>
              <span className="text-2xs text-muted-foreground">{part.description}</span>
              <span className="font-mono text-2xs wrap-anywhere text-muted-foreground">{part.hosts.join(', ')}</span>
            </span>
            {part.write_scope !== null && chosen.has(part.id) && (
              <span className="flex shrink-0 items-center gap-1.5 text-2xs text-muted-foreground">
                <Pencil className="size-3" aria-hidden />
                Write
                <Switch
                  aria-label={`${part.title} write`}
                  checked={writes.has(part.id)}
                  onCheckedChange={(on) => {
                    onWrite(part.id, on)
                  }}
                />
              </span>
            )}
            <Switch
              aria-label={part.title}
              checked={chosen.has(part.id)}
              onCheckedChange={(on) => {
                onToggle(part.id, on)
              }}
            />
          </li>
        ))}
      </ul>
    </Field>
  )
}

/** What saving will add: each connection's name, hosts and variable, or what is still missing. */
function Plan({ plan }: { plan: ReturnType<typeof expandTemplate> }) {
  if ('error' in plan) {
    return <p className="col-span-full text-xs text-muted-foreground">{plan.error} to add it.</p>
  }
  return (
    <Field label="Adds" full>
      <ul aria-label="Adds" className="border border-border text-xs">
        {plan.connections.map((connection) => (
          <li key={connection.name} className="border-b border-border px-3 py-2 last:border-b-0">
            <span className="font-mono font-medium">{connection.name}</span>
            <span className="block font-mono text-2xs wrap-anywhere text-muted-foreground">
              {connection.hosts.join(', ')} - {connection.env}
            </span>
          </li>
        ))}
      </ul>
    </Field>
  )
}

/** A service's short form: only what it needs, in its own words, and the credentials to carry it. */
export function TemplateForm({
  template,
  taken,
  onBack,
  onCreated,
}: {
  template: ConnectionTemplate
  taken: TemplateTaken
  onBack: () => void
  onCreated: (made: Connection[]) => void
}) {
  const [typed, setTyped] = useState<Record<string, string>>({})
  const [parts, setParts] = useState<ReadonlySet<string>>(new Set())
  const [writes, setWrites] = useState<ReadonlySet<string>>(new Set())
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set())
  const [saving, setSaving] = useState(false)
  const credentials = useCredentialList()
  const given = (secret: boolean) =>
    Object.fromEntries(
      template.fields
        .filter((field) => (field.slot !== null) === secret && (typed[field.key] ?? '').trim() !== '')
        .map((field) => [field.key, typed[field.key] ?? '']),
    )
  const fields = given(false)
  const picked = { parts: [...parts], write: [...writes] }
  const plan = expandTemplate(template, { ...picked, fields }, taken)

  const save = async () => {
    const body: ConnectionTemplateInput = {
      template: template.id,
      ...picked,
      fields,
      values: given(true),
      profile_ids: [...chosen],
    }
    setSaving(true)
    try {
      onCreated(await apiPost<Connection[]>('/connections/from-template', body))
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <CrudEditDialog
      open
      title={template.title}
      onCancel={onBack}
      onSave={() => void save()}
      saving={saving}
      canSave={!('error' in plan)}
      saveLabel="Add"
      savingLabel="Adding..."
      saveIcon={Plus}
    >
      <p className="col-span-full text-xs text-muted-foreground">
        {template.description}{' '}
        <a
          className="inline-flex items-center gap-1 text-foreground underline underline-offset-2"
          href={template.docs}
          target="_blank"
          rel="noreferrer"
        >
          <ExternalLink className="size-3" aria-hidden />
          Docs
        </a>
      </p>
      {template.fields.map((field) => (
        <FieldInput
          key={field.key}
          field={field}
          value={typed[field.key] ?? ''}
          onChange={(value) => {
            setTyped((prev) => ({ ...prev, [field.key]: value }))
          }}
        />
      ))}
      {template.parts.length > 0 && (
        <Parts
          template={template}
          chosen={parts}
          writes={writes}
          onToggle={(id, on) => {
            setParts((prev) => toggled(prev, id, on))
          }}
          onWrite={(id, on) => {
            setWrites((prev) => toggled(prev, id, on))
          }}
        />
      )}
      <Field label="Credentials" full>
        <div className="border border-border">
          <CredentialSwitches
            connection={template.title}
            credentials={credentials}
            chosen={chosen}
            onToggle={(id, on) => {
              setChosen((prev) => toggled(prev, id, on))
            }}
          />
        </div>
      </Field>
      <Plan plan={plan} />
      <p className="col-span-full text-2xs text-muted-foreground">
        {template.note !== '' && `${template.note} `}Values go to Seti and never come back. Agents of the credentials
        switched on see the variable with a placeholder; the proxy puts the value only on these hosts.
      </p>
    </CrudEditDialog>
  )
}
