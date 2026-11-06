import { defineMod, type ChangelogStatus, type ModSignal, type UiModApi } from '@seti/mod-api'
import { WhatsNewBody } from './WhatsNewBody'
import { type WhatsNew, WhatsNewContext } from './mod-context'
import manifest from './seti-mod.json' with { type: 'json' }

/** The version only changes when Seti restarts, so a slow poll finds a deploy soon enough. */
const STATUS_POLL_MS = 5 * 60_000

const changesView = (whatsNew: WhatsNew) =>
  function WhatsNewChanges() {
    return (
      <WhatsNewContext.Provider value={whatsNew}>
        <WhatsNewBody />
      </WhatsNewContext.Provider>
    )
  }

/** News while a deploy brought features or fixes the user has not opened the changelog for. */
const unseenNews = ({ status }: WhatsNew): ModSignal => ({
  subscribe: status.subscribe,
  get: () => (status.getSnapshot().data?.unseen ?? 0) > 0,
})

/** What changed in Seti, in Settings, About, with a dot on the way there while news waits. */
export const whatsNewUi = defineMod({
  manifest,
  ui: (api: UiModApi) => {
    const whatsNew = { api, status: api.poll<ChangelogStatus>('/status', STATUS_POLL_MS) }
    api.registerView({ id: 'changes', view: changesView(whatsNew) })
    api.registerNews({ view: 'changes', news: unseenNews(whatsNew) })
  },
})
