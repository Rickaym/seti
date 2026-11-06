import type { SetiPlugin } from '@seti/shared'
import { Plus } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { apiPost, errorText } from '@/api'
import { CrudEditDialog, Field } from '@/components/crud/CrudForm'
import { Input } from '@/components/ui/input'

export function AddPluginDialog({ onClose, onAdded }: { onClose: () => void; onAdded: (plugin: SetiPlugin) => void }) {
  const [path, setPath] = useState('')
  const [saving, setSaving] = useState(false)

  const save = async () => {
    setSaving(true)
    try {
      onAdded(await apiPost<SetiPlugin>('/plugins/defaults', { path }))
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <CrudEditDialog
      open
      title="Add local plugin"
      onCancel={onClose}
      onSave={() => void save()}
      saving={saving}
      saveLabel="Add"
      savingLabel="Adding..."
      saveIcon={Plus}
    >
      <Field label="Plugin folder" full>
        <Input
          aria-label="Plugin folder"
          value={path}
          onChange={(e) => {
            setPath(e.target.value)
          }}
          placeholder="~/my-plugin"
        />
      </Field>
      <p className="col-span-full text-xs text-muted-foreground">
        The folder needs a .claude-plugin/plugin.json. Seti loads it into every agent through the Agent SDK, and each
        agent can opt out. Claude Code in your terminal is not changed.
      </p>
    </CrudEditDialog>
  )
}
