import { RUNTIME_NAMES, type ContextPack, type RoleRuntimeInput } from '@seti/shared'
import { BrainCircuit } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { apiPut, errorText } from '@/api'
import { NativeSelectOptGroup, NativeSelectOption } from '@/components/ui/native-select'
import { useRuntimes } from '@/hooks/useRuntimes'
import { modelGroups, pickOf, pickValue } from '@/lib/runtime-pick'
import { IconSelect } from '@/panels/tasks/ModelPicker'

const ANY = ''

const valueOf = (pack: ContextPack) =>
  pack.runtime === null && pack.model === null
    ? ANY
    : pickValue({ runtime: pack.runtime ?? 'claude', model: pack.model, effort: null })

const hintOf = (pack: ContextPack) =>
  pack.runtime === null
    ? "Agents started in this role run on the start's own model, else your default."
    : `Agents started in this role run on ${RUNTIME_NAMES[pack.runtime]} with ${pack.model ?? 'its default model'}, unless their start names one.`

/** The runtime and model an agent started in this role runs on unless its start names one. */
export function RoleRuntime({ pack, onChanged }: { pack: ContextPack; onChanged: (pack: ContextPack) => void }) {
  const offers = useRuntimes().data?.offers ?? []
  const [busy, setBusy] = useState(false)
  const value = valueOf(pack)
  const groups = modelGroups(offers)
  const offered = value === ANY || groups.some((group) => group.options.some((option) => option.value === value))
  const save = async (next: string) => {
    const pick = next === ANY ? null : pickOf(next, offers)
    const body: RoleRuntimeInput = { runtime: pick?.runtime ?? null, model: pick?.model ?? null }
    setBusy(true)
    try {
      onChanged(await apiPut<ContextPack>(`/context/packs/${pack.id}/runtime`, body))
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <IconSelect
      icon={BrainCircuit}
      label="Runs on"
      hint={hintOf(pack)}
      value={value}
      disabled={busy}
      onChange={(next) => {
        void save(next)
      }}
    >
      <NativeSelectOption value={ANY}>Any model</NativeSelectOption>
      {offered ? null : (
        <NativeSelectOption value={value}>{pack.model ?? RUNTIME_NAMES[pack.runtime ?? 'claude']}</NativeSelectOption>
      )}
      {groups.map((group) => (
        <NativeSelectOptGroup key={group.runtime} label={group.label}>
          {group.options.map((option) => (
            <NativeSelectOption key={option.value} value={option.value}>
              {option.label}
            </NativeSelectOption>
          ))}
        </NativeSelectOptGroup>
      ))}
    </IconSelect>
  )
}
