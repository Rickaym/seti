import type {
  ContextPack,
  ContextPackDefaultInput,
  ContextPackInput,
  NewContextPackInput,
  PackKind,
} from '@seti/shared'
import { Copy, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { apiDelete, apiGet, apiPost, apiPut, errorText } from '@/api'
import { Hint } from '@/components/Hint'
import { Markdown } from '@/components/Markdown'
import { Field } from '@/components/crud/CrudForm'
import { Button } from '@/components/ui/button'
import { useConfirm } from '@/components/ui/confirm-context'
import { Input } from '@/components/ui/input'
import { DefaultSwitch } from '@/panels/access/DefaultSwitch'
import { Banner, CodeArea, EditorFrame } from '@/panels/context/EditorFrame'
import { HistoryAside, HistoryButton } from '@/panels/context/HistoryAside'
import { PackLinks } from '@/panels/context/PackLinks'
import { RevisionHistory } from '@/panels/revisions/RevisionHistory'

interface PackForm {
  name: string
  description: string
  body: string
}

const EMPTY: PackForm = { name: '', description: '', body: '' }

const formOf = (pack: ContextPack): PackForm => ({ name: pack.name, description: pack.description, body: pack.body })

const sameForm = (a: PackForm, b: PackForm) => a.name === b.name && a.description === b.description && a.body === b.body

/** Links the pack to every agent without its own choice. */
function DefaultToggle({ pack, onChanged }: { pack: ContextPack; onChanged: (pack: ContextPack) => void }) {
  const [busy, setBusy] = useState(false)
  const toggle = async (on: boolean) => {
    setBusy(true)
    try {
      const body: ContextPackDefaultInput = { linked_by_default: on }
      onChanged(await apiPut<ContextPack>(`/context/packs/${pack.id}/default`, body))
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <DefaultSwitch
      name={pack.name}
      enabled={pack.linked_by_default}
      disabled={busy}
      onChange={(on) => {
        void toggle(on)
      }}
    />
  )
}

/** Makes an editable copy of a pack, such as a built-in role, and opens it. */
function DuplicateButton({ pack, onCopied }: { pack: ContextPack; onCopied: (copy: ContextPack) => void }) {
  const [busy, setBusy] = useState(false)
  const duplicate = async () => {
    setBusy(true)
    try {
      const copy = await apiPost<ContextPack>(`/context/packs/${pack.id}/duplicate`)
      toast.success(`Created ${copy.name}`)
      onCopied(copy)
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Hint text="Make an editable copy">
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void duplicate()}>
        <Copy />
        Duplicate to edit
      </Button>
    </Hint>
  )
}

const BUILTIN_ROLE_NOTE =
  "Built into Seti and read-only. An agent with this role reads it right after the Seti guide. Pick it in an agent's settings under Role, or duplicate it to make your own version."

const GUIDE_NOTE =
  "Built into Seti and read-only. Seti writes it for each agent, naming only the tools this machine has and following the agent's update mode; shown here for an agent that wakes on PR updates. Unlink it from an agent in its details, or turn off Default so new agents leave it out."

/** Seti's own pack: shown as agents read it, never edited or deleted; a role can be duplicated. */
function BuiltinPack({
  pack,
  onChanged,
  onCopied,
}: {
  pack: ContextPack
  onChanged: (pack: ContextPack) => void
  onCopied: (copy: ContextPack) => void
}) {
  const role = pack.kind === 'role'
  return (
    <EditorFrame
      title={pack.name}
      subtitle={pack.description}
      dirty={false}
      canSave={false}
      saving={false}
      readOnly
      onSave={() => undefined}
      actions={
        role ? <DuplicateButton pack={pack} onCopied={onCopied} /> : <DefaultToggle pack={pack} onChanged={onChanged} />
      }
      banner={<Banner tone="info">{role ? BUILTIN_ROLE_NOTE : GUIDE_NOTE}</Banner>}
    >
      <PackLinks pack={pack} />
      <div className="min-h-0 flex-1 overflow-y-auto border border-border p-3">
        <Markdown text={pack.body} />
      </div>
    </EditorFrame>
  )
}

interface KindCopy {
  title: string
  subtitle: string
  noun: string
  name: string
  description: string
  body: string
  placeholder: string
}

const COPY: Record<PackKind, KindCopy> = {
  reference: {
    title: 'New context pack',
    subtitle: 'Attached packs are added to the system prompt of an agent on every turn.',
    noun: 'context pack',
    name: 'acme-infra',
    description: 'When to attach this pack',
    body: 'Pack content',
    placeholder: 'Facts, conventions or references Claude should see when this pack is attached.',
  },
  role: {
    title: 'New role',
    subtitle: "An agent's standing role, right after the Seti guide in its prompt; each agent has at most one.",
    noun: 'role',
    name: 'Release lead',
    description: 'Which agents this role suits',
    body: 'Role content',
    placeholder: 'What this agent owns, what it hands to others and how it reports. Its first line sums it up.',
  },
}

export function PackEditor({
  packId,
  newKind,
  onSaved,
  onDefaultChanged,
  onDeleted,
  onDirtyChange,
  historyOpen,
  onToggleHistory,
}: {
  packId: string | null
  /** The kind a new pack gets. */
  newKind: PackKind
  onSaved: (pack: ContextPack) => void
  /** Refreshes without navigating, since the reply can arrive after the user has left. */
  onDefaultChanged: () => void
  onDeleted: () => void
  onDirtyChange: (dirty: boolean) => void
  historyOpen: boolean
  onToggleHistory: () => void
}) {
  const confirm = useConfirm()
  const [pack, setPack] = useState<ContextPack | null>(null)
  const [form, setForm] = useState<PackForm>(EMPTY)
  const [saving, setSaving] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [reload, setReload] = useState(0)
  const [saves, setSaves] = useState(0)

  useEffect(() => {
    if (packId === null) {
      return
    }
    apiGet<ContextPack>(`/context/packs/${packId}`)
      .then((loaded) => {
        setPack(loaded)
        setForm(formOf(loaded))
      })
      .catch((e: unknown) => {
        setLoadError(errorText(e))
      })
  }, [packId, reload])

  const baseline = pack === null ? EMPTY : formOf(pack)
  const dirty = !sameForm(form, baseline)
  useEffect(() => {
    onDirtyChange(dirty)
  }, [dirty, onDirtyChange])

  const save = async () => {
    setSaving(true)
    try {
      const created: NewContextPackInput = { ...form, kind: newKind }
      const edited: ContextPackInput = form
      const saved =
        pack === null
          ? await apiPost<ContextPack>('/context/packs', created)
          : await apiPut<ContextPack>(`/context/packs/${pack.id}`, edited)
      setPack(saved)
      setForm(formOf(saved))
      setSaves((n) => n + 1)
      onDirtyChange(false)
      onSaved(saved)
      toast.success('Saved')
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    if (pack === null) {
      return
    }
    const message = `Delete ${COPY[pack.kind].noun} "${pack.name}"? Agents that use it stop seeing it from their next turn.`
    if (!(await confirm({ message, variant: 'destructive', confirmLabel: 'Delete' }))) {
      return
    }
    try {
      await apiDelete(`/context/packs/${pack.id}`)
      onDirtyChange(false)
      onDeleted()
    } catch (e) {
      toast.error(errorText(e))
    }
  }

  if (packId !== null && pack === null) {
    return <div className="p-6 text-sm text-muted-foreground">{loadError === '' ? 'Loading...' : loadError}</div>
  }

  const changed = (next: ContextPack) => {
    setPack(next)
    onDefaultChanged()
  }

  if (pack?.builtin === true) {
    return <BuiltinPack pack={pack} onChanged={changed} onCopied={onSaved} />
  }
  const copy = COPY[pack?.kind ?? newKind]

  const set = (key: keyof PackForm) => (value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  return (
    <EditorFrame
      title={pack === null ? copy.title : pack.name}
      subtitle={copy.subtitle}
      dirty={dirty}
      canSave={dirty && form.name.trim() !== ''}
      saving={saving}
      onSave={() => void save()}
      actions={
        pack !== null && (
          <>
            {pack.kind === 'reference' && <DefaultToggle pack={pack} onChanged={changed} />}
            <HistoryButton open={historyOpen} onToggle={onToggleHistory} />
            <Hint text={`Delete ${copy.noun}`}>
              <Button variant="outline" size="icon-sm" aria-label={`Delete ${copy.noun}`} onClick={() => void remove()}>
                <Trash2 />
              </Button>
            </Hint>
          </>
        )
      }
      aside={
        pack !== null &&
        historyOpen && (
          <HistoryAside>
            <RevisionHistory
              objectType="context_pack"
              objectId={pack.id}
              version={reload + saves}
              discardsEdits={dirty}
              onReverted={() => {
                setReload((v) => v + 1)
                onDirtyChange(false)
              }}
            />
          </HistoryAside>
        )
      }
    >
      <PackLinks pack={pack} />
      <div className="grid shrink-0 grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <Field label="Name">
          <Input
            aria-label="Name"
            value={form.name}
            placeholder={copy.name}
            onChange={(e) => {
              set('name')(e.target.value)
            }}
          />
        </Field>
        <Field label="Description">
          <Input
            aria-label="Description"
            value={form.description}
            placeholder={copy.description}
            onChange={(e) => {
              set('description')(e.target.value)
            }}
          />
        </Field>
      </div>
      <CodeArea label={copy.body} value={form.body} onChange={set('body')} placeholder={copy.placeholder} />
    </EditorFrame>
  )
}
