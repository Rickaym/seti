import { defineMod, type ModViewProps, type UiModApi } from '@seti/mod-api'
import { NotepadText } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type Ref } from 'react'
import { PadWindow } from './PadWindow.js'
import { PadStore } from './pad-store.js'
import { PAD_MAX } from './pad-text.js'
import { PadWindowState } from './pad-window.js'
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
function PadField({
  store,
  api,
  className,
  fieldRef,
}: PadParts & { className?: string; fieldRef?: Ref<HTMLTextAreaElement> }) {
  const state = useSyncExternalStore(store.subscribe, store.get)
  const { PlainTextarea, cn } = api.kit
  return (
    <>
      <PlainTextarea
        ref={fieldRef}
        aria-label="Pad"
        placeholder="Notes"
        value={state.text}
        readOnly={!state.ready}
        maxLength={PAD_MAX}
        spellCheck
        aria-invalid={state.failure !== null}
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

const FIELD_CLASS = 'border-0 px-4 py-2 text-base focus-visible:ring-inset md:text-sm dark:bg-transparent'

/** On the rail, which is too narrow for text, the pad is an icon that opens it as a window. */
function RailPad({ store, api, place }: PadParts & { place: PadWindowState }) {
  const open = useSyncExternalStore(place.subscribe, place.isOpen)
  const failed = useSyncExternalStore(store.subscribe, () => store.get().failure !== null)
  const [clicked, setClicked] = useState(false)
  const field = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (open && clicked) {
      field.current?.focus()
    }
  }, [open, clicked])
  const close = useCallback(() => {
    place.setOpen(false)
    document.querySelector<HTMLElement>('[data-pad-toggle]')?.focus()
  }, [place])
  const { Button, Hint, cn } = api.kit
  return (
    <>
      <Hint text="Pad">
        <Button
          variant="ghost"
          aria-label="Pad"
          aria-pressed={open}
          data-pad-toggle=""
          className={cn(
            'relative size-9 p-0',
            open ? 'bg-primary text-primary-foreground hover:bg-primary/90' : 'text-foreground/70',
          )}
          onClick={() => {
            setClicked(!open)
            place.setOpen(!open)
            void store.refresh()
          }}
        >
          <NotepadText className="size-[18px]" />
          {failed && <span aria-hidden className="absolute top-1 right-1 size-2 rounded-full bg-destructive" />}
        </Button>
      </Hint>
      {open && (
        <PadWindow api={api} place={place} onClose={close}>
          <PadField store={store} api={api} fieldRef={field} className={FIELD_CLASS} />
        </PadWindow>
      )}
    </>
  )
}

const padView = (api: UiModApi, store: PadStore, place: PadWindowState) =>
  function Pad({ layout }: ModViewProps) {
    useEffect(() => {
      void store.refresh()
    }, [])
    if (layout === 'rail') {
      return <RailPad store={store} api={api} place={place} />
    }
    return <PadField store={store} api={api} className={FIELD_CLASS} />
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
    api.registerView({ id: 'pad', view: padView(api, store, new PadWindowState()) })
    api.onDispose(() => {
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
      window.removeEventListener('pagehide', flush)
      void store.flush()
      store.dispose()
    })
  },
})
