import { defineMod, type ModFenceProps, type ModSectionProps, type UiModApi } from '@seti/mod-api'
import { FlaskConical, Hand, Plus } from 'lucide-react'
import { useEffect, useState, useSyncExternalStore } from 'react'
import manifest from './seti-mod.json' with { type: 'json' }

/** The sample's section: its greeting from its own route, and a count kept in its storage. */
const homeView = (api: UiModApi) =>
  function SampleHome({ id }: ModSectionProps) {
    const [greeting, setGreeting] = useState('')
    const [count, setCount] = useState<number | null>(null)
    useEffect(() => {
      void api.request<{ text: string }>('GET', '/hello').then((answer) => {
        setGreeting(answer.text)
      })
    }, [])
    return (
      <div className="space-y-3 p-4 text-sm">
        <h1 className="text-lg font-semibold">Sample</h1>
        <p>{greeting}</p>
        {id !== null && <p>Opened at {id}</p>}
        <button
          type="button"
          className="border border-border px-3 py-1"
          onClick={() => {
            void api.request<{ count: number }>('POST', '/count').then((answer) => {
              setCount(answer.count)
            })
          }}
        >
          Count
        </button>
        {count !== null && <p>Counted {count}</p>}
      </div>
    )
  }

/** How many times the sample's input hook saw Alt+Shift+K. */
const keys = { count: 0, listeners: new Set<() => void>() }

const subscribeKeys = (listener: () => void) => {
  keys.listeners.add(listener)
  return () => {
    keys.listeners.delete(listener)
  }
}

function onKeyDown(e: KeyboardEvent) {
  if (e.altKey && e.shiftKey && e.code === 'KeyK') {
    e.preventDefault()
    keys.count += 1
    for (const listener of keys.listeners) {
      listener()
    }
  }
}

function SampleStatus() {
  const count = useSyncExternalStore(subscribeKeys, () => keys.count)
  return <span className="flex items-center px-2">Sample on{count > 0 && `, ${String(count)} keys`}</span>
}

function SampleFence({ source }: ModFenceProps) {
  return <p className="border border-border p-2 text-sm">Sample fence: {source.trim().toUpperCase()}</p>
}

/** Registers a section, status item, viewer, fence, command icons and a key; Seti draws settings. */
export const sampleUi = defineMod({
  manifest,
  ui: (api) => {
    api.registerSection({ id: 'home', icon: FlaskConical, view: homeView(api) })
    api.registerStatusBarItem({ id: 'count', view: SampleStatus })
    api.registerFileViewer({ id: 'notes', load: async () => import('./NotesView').then((m) => m.NotesView) })
    api.registerFenceRenderer({ language: 'sample', view: SampleFence })
    api.registerCommand({ id: 'count', icon: Plus })
    api.registerCommand({ id: 'wave', icon: Hand })
    api.registerInputHook({ id: 'keys', onKeyDown })
  },
})
