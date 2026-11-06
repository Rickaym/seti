import type { InstalledPlugin } from '@seti/shared'
import { Loader2, RefreshCw } from 'lucide-react'
import { apiDelete, apiPatch, apiPost } from '@/api'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { useConfirm } from '@/components/ui/confirm-context'
import { Switch } from '@/components/ui/switch'
import { DeleteIconButton } from '@/components/ui/table-action-buttons'
import { NEXT_SESSION_NOTE, usePluginAction } from './usePluginAction'

const CHANGEABLE = new Set(['user', 'project', 'local'])

const pluginPath = (plugin: InstalledPlugin) => `/plugins/installed/${encodeURIComponent(plugin.id)}`

/** Enable, update and uninstall for a Claude Code plugin; managed plugins stay read-only. */
export function InstalledActions({ plugin, onChanged }: { plugin: InstalledPlugin; onChanged: () => void }) {
  const confirm = useConfirm()
  const { busy, run } = usePluginAction(onChanged)
  if (!CHANGEABLE.has(plugin.scope)) {
    return null
  }

  const setEnabled = (enabled: boolean) =>
    void run(
      async () => apiPatch(pluginPath(plugin), { enabled }),
      `${plugin.name} is ${enabled ? 'enabled' : 'disabled'}`,
      NEXT_SESSION_NOTE,
    )

  const update = () =>
    void run(async () => apiPost(`${pluginPath(plugin)}/update`), `Updated ${plugin.name}`, NEXT_SESSION_NOTE)

  const uninstall = async () => {
    const message = `Uninstall ${plugin.id} from Claude Code? Agents and your terminal stop loading it.`
    if (!(await confirm({ title: 'Uninstall plugin', message, confirmLabel: 'Uninstall', variant: 'destructive' }))) {
      return
    }
    await run(async () => apiDelete(pluginPath(plugin)), `Uninstalled ${plugin.name}`, NEXT_SESSION_NOTE)
  }

  return (
    <span className="flex items-center gap-1.5">
      <Hint text="On in Claude Code: agents and your terminal load it" side="left">
        <span className="flex">
          <Switch
            aria-label={`${plugin.name} enabled`}
            checked={plugin.enabled}
            disabled={busy}
            onCheckedChange={setEnabled}
          />
        </span>
      </Hint>
      <Button
        type="button"
        variant="outline"
        size="icon-xs"
        aria-label={`Update ${plugin.name}`}
        title={`Update ${plugin.name}`}
        disabled={busy}
        onClick={update}
      >
        {busy ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
      </Button>
      <DeleteIconButton aria-label={`Uninstall ${plugin.name}`} disabled={busy} onClick={() => void uninstall()} />
    </span>
  )
}
