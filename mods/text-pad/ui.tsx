import { defineMod, type ModViewProps, type UiModApi } from '@seti/mod-api'
import { NotepadText } from 'lucide-react'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { PadStore } from './pad-store.js'
import { PAD_MAX } from './pad-text.js'
import manifest from './seti-mod.json' with { type: 'json' }

const BACKUP_KEY = 'seti.text-pad.unsaved'

/** This browser's copy of text a save has not stored yet; storage that throws keeps nothing. */
const backup = {
  read: () => {
    try {
      return localStorage.getItem(BACKUP_KEY)
    } catch {
      return null
    }
  },
  write: (text: string | null) => {
    try {
      if (text === null) {
        localStorage.removeItem(BACKUP_KEY)
      } else {
        localStorage.setItem(BACKUP_KEY, text)
      }
    } catch {
      // A browser without storage keeps the unsaved text in memory only.
    }
  },
}

interface PadParts {
  store: PadStore
  api: UiModApi
}

/** The text area itself: saves as typing pauses and on blur, and says so only when a save fails. */
function PadField({ store, api, className }: PadParts & { className?: string }) {
  const state = useSyncExternalStore(store.subscribe, store.get)
  const { Textarea, cn } = api.kit
  return (
    <>
      <Textarea
        aria-label="Pad"
        placeholder="Notes"
        value={state.text}
        readOnly={!state.ready}
        maxLength={PAD_MAX}
        spellCheck
        aria-invalid={state.failure !== null}
        boxClassName="min-h-0 flex-1"
        className={cn('field-sizing-fixed min-h-0 flex-1 resize-none', className)}
        onChange={(event) => {
          store.edit(event.target.value)
        }}
        onBlur={() => {
          void store.flush()
        }}
      />
      {state.failure !== null && (
        <p role="alert" className="shrink-0 px-4 py-1 text-xs text-destructive">
          Not saved, retrying: {state.failure}
        </p>
      )}
    </>
  )
}

/** On the rail, which is too narrow for text, the pad is an icon that opens it in a dialog. */
function RailPad({ store, api }: PadParts) {
  const [open, setOpen] = useState(false)
  const failed = useSyncExternalStore(store.subscribe, () => store.get().failure !== null)
  const { Button, Dialog, Hint } = api.kit
  return (
    <>
      <Hint text="Pad">
        <Button
          variant="ghost"
          aria-label="Pad"
          className="relative size-9 p-0 text-foreground/70"
          onClick={() => {
            setOpen(true)
            void store.refresh()
          }}
        >
          <NotepadText className="size-[18px]" />
          {failed && <span aria-hidden className="absolute top-1 right-1 size-2 rounded-full bg-destructive" />}
        </Button>
      </Hint>
      <Dialog open={open} onOpenChange={setOpen} title="Pad" className="sm:max-w-xl">
        <div className="flex h-[60vh] min-h-40 flex-col">
          <PadField store={store} api={api} className="text-sm md:text-sm" />
        </div>
      </Dialog>
    </>
  )
}

const padView = (api: UiModApi, store: PadStore) =>
  function Pad({ layout }: ModViewProps) {
    useEffect(() => {
      void store.refresh()
    }, [])
    if (layout === 'rail') {
      return <RailPad store={store} api={api} />
    }
    return (
      <PadField
        store={store}
        api={api}
        className="border-0 px-4 py-2 text-base focus-visible:ring-inset md:text-sm dark:bg-transparent"
      />
    )
  }

/** A text pad at the bottom of the navigation, kept on the server and saved as the user types. */
export const textPadUi = defineMod({
  manifest,
  ui: (api) => {
    const store = new PadStore({
      load: async () => (await api.request<{ text: string }>('GET', '/text')).text,
      save: async (text) => {
        await api.request('PUT', '/text', { text })
      },
      backup,
      errorText: api.kit.errorText,
    })
    const refresh = () => {
      if (document.visibilityState === 'visible') {
        void store.refresh()
      } else {
        void store.flush()
      }
    }
    const flush = () => {
      void store.flush()
    }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    window.addEventListener('pagehide', flush)
    api.registerView({ id: 'pad', view: padView(api, store) })
    api.onDispose(() => {
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
      window.removeEventListener('pagehide', flush)
      void store.flush()
      store.dispose()
    })
  },
})
