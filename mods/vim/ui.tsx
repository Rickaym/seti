import { defineMod, type Disposer, type UiModApi } from '@seti/mod-api'
import { cheatSheet } from './CheatSheet'
import { modeItem } from './ModeItem'
import { VimKeys } from './keys'
import manifest from './seti-mod.json' with { type: 'json' }

/** Runs the keys while the screen is wide enough for panels; a phone never takes them. */
function followWidth(api: UiModApi, keys: VimKeys): void {
  const { narrow } = api.app
  let stop: Disposer | null = null
  const sync = () => {
    if (!narrow.get() && stop === null) {
      stop = keys.watch()
    } else if (narrow.get() && stop !== null) {
      stop()
      stop = null
    }
  }
  sync()
  api.onDispose(narrow.subscribe(sync))
  api.onDispose(() => {
    stop?.()
  })
}

/** Single-key Vim bindings for Seti's panels; turning the mod on is the opt-in. */
export const vimUi = defineMod({
  manifest,
  ui: (api) => {
    const keys = new VimKeys(api)
    api.registerInputHook({
      id: 'keys',
      onKeyDown: keys.onKeyDown,
      takesEscape: keys.takesEscape,
      onFindEnter: keys.onFindEnter,
      overlay: cheatSheet(api.kit),
    })
    api.registerStatusBarItem({ id: 'mode', view: modeItem(api.kit) })
    followWidth(api, keys)
  },
})
