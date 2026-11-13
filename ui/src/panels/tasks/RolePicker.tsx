import {
  BUILTIN_ROLES,
  roleLabel,
  type ContextPack,
  type ContextPackSummary,
  type NewContextPackInput,
  type TaskRoleInput,
} from '@seti/shared'
import { Copy, Pencil, Users } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type Ref } from 'react'
import { toast } from 'sonner'
import { apiGet, apiPost, apiPut, errorText } from '@/api'
import { Hint } from '@/components/Hint'
import { CrudEditDialog, Field } from '@/components/crud/CrudForm'
import { FindableTextarea } from '@/components/find/FindableTextarea'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { navigate } from '@/lib/route'
import { packSelection } from '@/panels/context/selection'

const NONE = ''
const NEW = 'new'
const LEAD_ID = BUILTIN_ROLES.find((role) => role.name === 'Lead')?.id ?? ''

/** Who takes a role pack: an agent or the EA, by the routes that list and link its packs. */
export interface RoleOwner {
  /** Lists the packs it links. */
  packsPath: string
  /** Takes { pack_id } and links that role pack in place of the current one. */
  rolePath: string
  /** Names a new role "<name> role" and titles its editor. */
  name: string
  /** Offers the built-in Lead with one click while it has no role. */
  pinned: boolean
}

/** Every role pack, Seti's first, and the one the owner links; null while loading. */
function useRoles(packsPath: string) {
  const [roles, setRoles] = useState<ContextPack[] | null>(null)
  const [current, setCurrent] = useState<string | null>(null)
  const load = useCallback(() => {
    Promise.all([apiGet<ContextPack[]>('/context/packs'), apiGet<ContextPackSummary[]>(packsPath)])
      .then(([packs, linked]) => {
        const all = packs.filter((pack) => pack.kind === 'role')
        setRoles([...all.filter((pack) => pack.builtin), ...all.filter((pack) => !pack.builtin)])
        setCurrent(linked.find((pack) => pack.kind === 'role')?.id ?? null)
      })
      .catch((e: unknown) => {
        setRoles([])
        toast.error(errorText(e))
      })
  }, [packsPath])
  useEffect(load, [load])
  return { roles, current, load }
}

async function linkRole(owner: RoleOwner, packId: string | null): Promise<void> {
  const body: TaskRoleInput = { pack_id: packId }
  await apiPut<ContextPackSummary[]>(owner.rolePath, body)
}

interface RolePickerProps {
  owner: RoleOwner
  /** Focuses the picker once it has loaded, as the palette's Change role asks. */
  focus: boolean
  onChanged: () => void
  /** Opens the new role editor, starting from this text. */
  onNew: (body: string) => void
  /** Closes the settings before leaving for the Context page. */
  onLeave: () => void
}

function RoleGroup({ label, roles }: { label: string; roles: readonly ContextPack[] }) {
  if (roles.length === 0) {
    return null
  }
  return (
    <optgroup label={label}>
      {roles.map((role) => (
        <NativeSelectOption key={role.id} value={role.id}>
          {role.name}
        </NativeSelectOption>
      ))}
    </optgroup>
  )
}

function RoleSelect({
  ref,
  roles,
  value,
  disabled,
  onPick,
}: {
  ref: Ref<HTMLSelectElement>
  roles: readonly ContextPack[]
  value: string
  disabled: boolean
  onPick: (value: string) => void
}) {
  return (
    <NativeSelect
      ref={ref}
      aria-label="Role"
      size="sm"
      className="min-w-0"
      value={value}
      disabled={disabled}
      onChange={(event) => {
        onPick(event.target.value)
      }}
    >
      <NativeSelectOption value={NONE}>None</NativeSelectOption>
      <RoleGroup label="Built in" roles={roles.filter((role) => role.builtin)} />
      <RoleGroup label="Yours" roles={roles.filter((role) => !role.builtin)} />
      <NativeSelectOption value={NEW}>New role...</NativeSelectOption>
    </NativeSelect>
  )
}

/** The owner's role pack: pick one, start a new one, edit or duplicate it, or go without. */
export function RolePicker({ owner, focus, onChanged, onNew, onLeave }: RolePickerProps) {
  const { roles, current, load } = useRoles(owner.packsPath)
  const select = useRef<HTMLSelectElement>(null)
  const [busy, setBusy] = useState(false)
  const pack = roles?.find((role) => role.id === current) ?? null

  useEffect(() => {
    if (focus && roles !== null) {
      select.current?.focus()
    }
  }, [focus, roles])

  const run = async (work: () => Promise<void>) => {
    setBusy(true)
    try {
      await work()
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const pick = async (value: string) =>
    run(async () => {
      if (value === NEW) {
        onNew(pack?.body ?? '')
        return
      }
      await linkRole(owner, value === NONE ? null : value)
      toast.success('Applies from the next turn')
      load()
      onChanged()
    })

  const edit = async () =>
    run(async () => {
      if (pack === null) {
        return
      }
      const target = pack.builtin ? await apiPost<ContextPack>(`/context/packs/${pack.id}/duplicate`) : pack
      if (pack.builtin) {
        await linkRole(owner, target.id)
        toast.success(`${target.name} is the role of ${owner.name} now; edit it here`)
        onChanged()
      }
      onLeave()
      navigate('context', packSelection(target.id))
    })

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 items-center gap-1">
        <RoleSelect
          ref={select}
          roles={roles ?? []}
          value={current ?? NONE}
          disabled={busy}
          onPick={(value) => void pick(value)}
        />
        {pack !== null && (
          <Hint text={pack.builtin ? 'Duplicate it into a role of your own and edit that' : 'Edit this role'}>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={pack.builtin ? 'Duplicate role to edit' : 'Edit role'}
              disabled={busy}
              onClick={() => void edit()}
            >
              {pack.builtin ? <Copy /> : <Pencil />}
            </Button>
          </Hint>
        )}
      </div>
      {pack !== null && (
        <span data-testid="task-role" className="truncate text-2xs text-muted-foreground">
          {roleLabel(pack.name, pack.body)}
        </span>
      )}
      {owner.pinned && roles !== null && current === null && (
        <div className="flex flex-wrap items-center gap-1.5 text-2xs text-muted-foreground">
          <span>Pinned agents work best with a role</span>
          <Hint text="The built-in Lead role: delegate instead of implementing">
            <Button size="xs" variant="outline" disabled={busy} onClick={() => void pick(LEAD_ID)}>
              <Users />
              Lead
            </Button>
          </Hint>
        </div>
      )}
    </div>
  )
}

/** A new role pack for the owner, linked to it once saved; built-in roles are starting points. */
export function NewRoleDialog({
  owner,
  initial,
  onChanged,
  onClose,
}: {
  owner: RoleOwner
  initial: string
  onChanged: () => void
  onClose: () => void
}) {
  const [name, setName] = useState(`${owner.name} role`.slice(0, 80))
  const [body, setBody] = useState(initial)
  const [saving, setSaving] = useState(false)
  const save = async () => {
    setSaving(true)
    try {
      const input: NewContextPackInput = { name, description: '', body, kind: 'role' }
      const pack = await apiPost<ContextPack>('/context/packs', input)
      await linkRole(owner, pack.id)
      toast.success('Applies from the next turn')
      onChanged()
      onClose()
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setSaving(false)
    }
  }
  return (
    <CrudEditDialog
      open
      title={`New role for ${owner.name}`}
      onCancel={onClose}
      onSave={() => void save()}
      saving={saving}
      canSave={name.trim() !== '' && body.trim() !== ''}
    >
      <Field label="Name" full>
        <Input
          aria-label="Name"
          value={name}
          maxLength={80}
          onChange={(e) => {
            setName(e.target.value)
          }}
        />
      </Field>
      <Field label="Start from" full>
        <div className="flex flex-wrap gap-1.5">
          {BUILTIN_ROLES.map((role) => (
            <Hint key={role.id} text={role.description}>
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={() => {
                  setBody(role.text)
                }}
              >
                {role.name}
              </Button>
            </Hint>
          ))}
        </div>
      </Field>
      <Field label="Role" full>
        <FindableTextarea
          aria-label="Role content"
          className="max-h-[50vh] min-h-40 font-mono"
          placeholder="What this agent owns, what it hands to others and how it reports. Its first line sums it up."
          value={body}
          onChange={(e) => {
            setBody(e.target.value)
          }}
        />
        <span className="text-2xs text-muted-foreground">
          A role pack under Context, in its system prompt from the next turn; other agents see its first line.
        </span>
      </Field>
    </CrudEditDialog>
  )
}
