import type { SettingsConfirm, SettingsPatchInput, SettingsWriteRefusal } from '@seti/shared'
import { useState } from 'react'
import { toast } from 'sonner'
import { errorText } from '@/api'
import type { ChangeRow } from './json-edit'
import { announceSaved, sendWrite } from './write-client'

/** A write the user is looking at before it applies. */
export interface Planned {
  rows: ChangeRow[]
  body: SettingsPatchInput
}

/** The preview, confirm and save steps every JSON write goes through, from the editor or Reset. */
export function useWrite(onSaved: () => void, onRefused: (refusal: SettingsWriteRefusal) => void) {
  const [planned, setPlanned] = useState<Planned | null>(null)
  const [confirm, setConfirm] = useState<SettingsConfirm[]>([])
  const [busy, setBusy] = useState(false)
  const close = () => {
    setPlanned(null)
    setConfirm([])
  }
  const save = async () => {
    if (planned === null) {
      return
    }
    setBusy(true)
    try {
      const outcome = await sendWrite({ ...planned.body, confirm: confirm.map((item) => item.id) })
      if ('saved' in outcome) {
        close()
        announceSaved(outcome.saved, onSaved)
        onSaved()
      } else if (outcome.refused.title === 'Confirm') {
        setConfirm(outcome.refused.confirm)
      } else {
        close()
        onRefused(outcome.refused)
      }
    } catch (e) {
      toast.error(errorText(e), { duration: Infinity })
    } finally {
      setBusy(false)
    }
  }
  return { planned, confirm, busy, open: setPlanned, close, save }
}
