import type { ModInfo } from '@seti/shared'
import { Power, Settings2 } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { apiPatch, errorText } from '@/api'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { useConfirm } from '@/components/ui/confirm-context'
import { refreshMods, useMods } from '@/hooks/useMods'
import { navigate } from '@/lib/route'
import { modShowing, type ViewedFile } from '@/panels/files/file-viewers'
import { modSettingsKey } from '@/panels/settings/mods/mod-settings-key'

function Note({ text, children }: { text: string; children: ReactNode }) {
  return (
    <div
      role="note"
      className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-1.5 text-xs text-muted-foreground"
    >
      <span className="min-w-0 flex-1">{text}</span>
      {children}
    </div>
  )
}

/** The mod is on and its switch for these files is off: one tap opens its settings at the switch. */
function SwitchOffNote({ mod, setting }: { mod: ModInfo; setting: string }) {
  const title = mod.manifest?.contributes.settings[setting]?.title ?? setting
  return (
    <Note text={`${mod.name} shows these files. ${title} is off.`}>
      <Hint text={`Open the ${mod.name} settings at its ${title} switch`}>
        <Button
          variant="outline"
          size="xs"
          onClick={() => {
            navigate('settings', `${modSettingsKey(mod.id)}/${setting}`)
          }}
        >
          <Settings2 />
          Settings
        </Button>
      </Hint>
    </Note>
  )
}

/** The whole mod is off: one tap turns it on, after a confirm for a security-sensitive one. */
function ModOffLine({ mod }: { mod: ModInfo }) {
  const confirm = useConfirm()
  const [busy, setBusy] = useState(false)
  const turnOn = async () => {
    const detail = mod.description
    if (
      mod.security_sensitive &&
      !(await confirm({ message: `Turn on ${mod.name}?`, detail, confirmLabel: 'Turn on' }))
    ) {
      return
    }
    setBusy(true)
    try {
      await apiPatch(`/mods/${mod.id}`, { enabled: true })
      refreshMods()
    } catch (e) {
      toast.error(`${mod.name} did not turn on`, { description: errorText(e), duration: Infinity })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Note text={`${mod.name} shows these files. It is off.`}>
      <Hint text={`Turn on the ${mod.name} mod to show this file with it`}>
        <Button variant="outline" size="xs" disabled={busy} onClick={() => void turnOn()}>
          <Power />
          Turn on
        </Button>
      </Hint>
    </Note>
  )
}

/** A line naming the mod, or its switch, that is off and would show this file. */
export function ModOffNote({ file }: { file: Pick<ViewedFile, 'name' | 'kind'> }) {
  const { data } = useMods()
  const off = data === undefined ? undefined : modShowing(data.mods, file)
  if (off === undefined) {
    return null
  }
  return off.setting === null ? <ModOffLine mod={off.mod} /> : <SwitchOffNote mod={off.mod} setting={off.setting} />
}
