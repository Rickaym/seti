import type { ModInfo, ModInstallInfo, ModList } from '@seti/shared'
import { Trash2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { apiPost, errorText } from '@/api'
import { ToggleButton } from '@/components/ToggleButton'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { refreshMods } from '@/hooks/useMods'
import { withStepUp } from '@/lib/passkeys'

const size = (bytes: number) => (bytes < 1024 ? `${String(bytes)} bytes` : `${String(Math.round(bytes / 1024))} KB`)

/** Removes a third-party mod and its versions, keeping or deleting its data as the user picks. */
export function UninstallDialog({
  mod,
  install,
  open,
  onOpenChange,
  onDone,
}: {
  mod: ModInfo
  install: ModInstallInfo
  open: boolean
  onOpenChange: (open: boolean) => void
  onDone: () => void
}) {
  const [deleteData, setDeleteData] = useState(true)
  const [busy, setBusy] = useState(false)
  const uninstall = async () => {
    setBusy(true)
    await withStepUp(async () =>
      apiPost<ModList>(`/mod-admin/mods/${mod.id}/uninstall`, { delete_data: deleteData }),
    ).then(
      () => {
        refreshMods()
        onDone()
      },
      (e: unknown) => {
        toast.error('Seti did not uninstall the mod', { description: errorText(e), duration: Infinity })
      },
    )
    setBusy(false)
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Uninstall {mod.name}?</DialogTitle>
        </DialogHeader>
        <p>
          Removes {mod.name} and its kept versions. It keeps {size(install.data_bytes)} of data and{' '}
          {install.settings_count} settings in Seti.
        </p>
        <ToggleButton
          pressed={deleteData}
          onPressedChange={setDeleteData}
          icon={Trash2}
          label="Delete its data"
          hint={deleteData ? 'Its data and settings go too' : 'Its data and settings stay for a later install'}
        />
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              onOpenChange(false)
            }}
          >
            Cancel
          </Button>
          <Button variant="destructive" disabled={busy} onClick={() => void uninstall()}>
            <Trash2 />
            Uninstall
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
