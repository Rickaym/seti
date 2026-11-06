import type { ModInfo } from '@seti/shared'
import { Power } from 'lucide-react'
import { useState } from 'react'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { useConfirm } from '@/components/ui/confirm-context'
import { grantsLine, turnModOn } from './commands'

/** In place of the composer's status: the command's mod is off, with one tap to turn it on. */
export function ModOffNotice({ mod }: { mod: ModInfo }) {
  const confirm = useConfirm()
  const [busy, setBusy] = useState(false)
  const grants = grantsLine(mod)
  const turnOn = async () => {
    const ask = { message: `Turn on ${mod.name}?`, detail: grants ?? mod.description, confirmLabel: 'Turn on' }
    if (mod.security_sensitive && !(await confirm(ask))) {
      return
    }
    setBusy(true)
    await turnModOn(mod).finally(() => {
      setBusy(false)
    })
  }
  return (
    <div role="status" aria-label="Composer status" className="flex min-h-5 items-center gap-2 px-1 text-2xs">
      <span className="min-w-0 truncate">{mod.name} is off</span>
      <Hint text={grants ?? `Turn ${mod.name} on, as Settings, Mods does`} side="top">
        <Button
          size="xs"
          variant="outline"
          className="pointer-coarse:min-h-11"
          disabled={busy}
          onClick={() => void turnOn()}
        >
          <Power />
          Turn on
        </Button>
      </Hint>
    </div>
  )
}
