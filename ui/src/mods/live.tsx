import { modScoped, type Disposer, type ModLiveInfo, type ModManifest, type ModThemeTokensInfo } from '@seti/shared'
import { Puzzle } from 'lucide-react'
import { apiGet } from '@/api'
import { ItemHint, StatusBarItem } from '@/components/status-bar/StatusBarItem'
import { statusBarItems } from '@/components/status-bar/items'
import { usePolled } from '@/hooks/usePolled'
import { createPolledResource } from '@/lib/polled'
import { runModCommand } from './commands'

const live = createPolledResource<ModLiveInfo>('/mod-live', 5000)

type StatusItem = ModManifest['contributes']['statusBar'][number]

function statusView(manifest: ModManifest, item: StatusItem) {
  const key = modScoped(manifest.id, item.id)
  const command = manifest.contributes.commands.find((entry) => entry.id === item.command)
  function ModStatusItem() {
    const shown = usePolled(live).data?.status.find((entry) => entry.key === key)
    if (shown === undefined || shown.text === '') {
      return null
    }
    const label = `${manifest.name}: ${shown.text}`
    return (
      <StatusBarItem
        label={label}
        name={item.title}
        tooltip={
          <ItemHint title={`${item.title}, from the ${manifest.name} mod`}>
            {command !== undefined && <span>Click to run {command.title}.</span>}
          </ItemHint>
        }
        onClick={
          command === undefined
            ? undefined
            : () => {
                void runModCommand(manifest, command, {}, { agent: null })
              }
        }
      >
        <Puzzle className="size-3" />
        <span>{shown.text}</span>
      </StatusBarItem>
    )
  }
  return ModStatusItem
}

/** Shows the status items a third-party mod's logic sets, as text Seti draws, never markup. */
export function registerStatusItems(manifest: ModManifest, track: (dispose: Disposer) => Disposer): void {
  for (const item of manifest.contributes.statusBar) {
    const key = modScoped(manifest.id, item.id)
    track(statusBarItems.register({ key, name: item.title, slot: 'work', view: statusView(manifest, item) }))
  }
}

/** Adds a third-party mod's theme tokens, as Seti checked and rebuilt them, while the mod runs. */
export async function registerThemeTokens(
  manifest: ModManifest,
  track: (dispose: Disposer) => Disposer,
): Promise<void> {
  if (manifest.contributes.themes.length === 0) {
    return
  }
  const { css } = await apiGet<ModThemeTokensInfo>(`/mod-live/${manifest.id}/themes`)
  const style = document.createElement('style')
  style.dataset.modTokens = manifest.id
  style.textContent = css
  document.head.append(style)
  track(() => {
    style.remove()
  })
}
