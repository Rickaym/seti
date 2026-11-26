import {
  roleLabel,
  type ContextPack,
  type ContextPackSummary,
  type NewContextPackInput,
  type TaskRoleInput,
} from '@seti/shared'
import { Pencil } from 'lucide-react'
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

/** Who takes a role pack: an agent or the EA, by the routes that list and link its packs. */
export interface RoleOwner {
  /** Lists the packs it links. */
  packsPath: string
  /** Takes { pack_id } and links that role pack in place of the current one. */
  rolePath: string
  /** Names a new role "<name> role" and titles its editor. */
  name: string
}

/** Every role pack and the one the owner links; null while loading. */
function useRoles(packsPath: string) {
  const [roles, setRoles] = useState<ContextPack[] | null>(null)
  const [current, setCurrent] = useState<string | null>(null)
  const load = useCallback(() => {
    Promise.all([apiGet<ContextPack[]>('/context/packs'), apiGet<ContextPackSummary[]>(packsPath)])
      .then(([packs, linked]) => {
        setRoles(packs.filter((pack) => pack.kind === 'role'))
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
      {roles.map((role) => (
        <NativeSelectOption key={role.id} value={role.id}>
          {role.name}
        </NativeSelectOption>
      ))}
      <NativeSelectOption value={NEW}>New role...</NativeSelectOption>
    </NativeSelect>
  )
}

/** The owner's role pack: pick one, start a new one, edit it, or go without. */
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

  const edit = () => {
    if (pack === null) {
      return
    }
    onLeave()
    navigate('context', packSelection(pack.id))
  }

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
          <Hint text="Edit this role">
            <Button size="icon-xs" variant="ghost" aria-label="Edit role" disabled={busy} onClick={edit}>
              <Pencil />
            </Button>
          </Hint>
        )}
      </div>
      {pack !== null && (
        <span data-testid="task-role" className="truncate text-2xs text-muted-foreground">
          {roleLabel(pack.name, pack.body)}
        </span>
      )}
    </div>
  )
}

/** A new role pack for the owner, linked to it once saved. */
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
