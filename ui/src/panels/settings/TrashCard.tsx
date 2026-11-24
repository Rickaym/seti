import type { TrashItem } from '@seti/shared'
import { ArchiveRestore, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { apiDelete, apiGet, apiPost, errorText } from '@/api'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { useConfirm } from '@/components/ui/confirm-context'
import { bytesLabel } from '@/panels/resources/format'
import { SettingRow, SettingsCard } from './layout'

const TITLE = 'Trash'

/** What clean-ups the user allowed moved aside: kept 14 days, restorable, emptied on request. */
export function TrashCard() {
  const confirm = useConfirm()
  const [items, setItems] = useState<TrashItem[] | null>(null)
  const load = useCallback(() => {
    apiGet<TrashItem[]>('/trash').then(setItems, (e: unknown) => toast.error(errorText(e)))
  }, [])
  useEffect(load, [load])

  const restore = (item: TrashItem) => {
    apiPost(`/trash/${String(item.id)}/restore`).then(load, (e: unknown) => toast.error(errorText(e)))
  }
  const empty = async () => {
    const message = 'Everything in the trash is removed for good and cannot be restored.'
    if (await confirm({ title: 'Empty the trash', message, confirmLabel: 'Empty' })) {
      apiDelete('/trash').then(load, (e: unknown) => toast.error(errorText(e)))
    }
  }

  const total = (items ?? []).reduce((sum, item) => sum + item.bytes, 0)
  return (
    <SettingsCard
      title={TITLE}
      actions={
        <Button size="sm" variant="outline" disabled={(items?.length ?? 0) === 0} onClick={() => void empty()}>
          <Trash2 />
          Empty
        </Button>
      }
    >
      <SettingRow
        label="Kept"
        description={`${String(items?.length ?? 0)} items, ${bytesLabel(total)}. Clean-ups you allowed stay here 14 days.`}
      >
        {null}
      </SettingRow>
      {(items ?? []).map((item) => (
        <SettingRow key={item.id} label={item.original_path.split('/').pop() ?? item.original_path} stack>
          <span className="min-w-0 truncate font-mono text-2xs text-muted-foreground">{item.original_path}</span>
          <Hint text={`Put it back at ${item.original_path}`}>
            <Button
              size="sm"
              variant="outline"
              aria-label={`Restore ${item.original_path}`}
              onClick={() => {
                restore(item)
              }}
            >
              <ArchiveRestore />
              Restore
            </Button>
          </Hint>
        </SettingRow>
      ))}
    </SettingsCard>
  )
}
