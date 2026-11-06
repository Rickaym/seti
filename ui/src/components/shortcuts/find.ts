/** The chats that take find: an agent's transcript and the group chat. */
export type ChatSearchTarget = 'agent' | 'team'

interface Finder {
  target: ChatSearchTarget
  /** The element focus must sit in for this chat to take Ctrl+F before the others. */
  root: () => HTMLElement | null
  open: () => void
  /** Whether the find bar shows, and stepping and closing it, for Vim mode's n, N and Esc. */
  isOpen: () => boolean
  step: (direction: 'older' | 'newer') => void
  close: () => void
}

const finders = new Set<Finder>()

/** Offers a shown chat to Ctrl+F and the command palette; returns the teardown. */
export function registerChatSearch(finder: Finder): () => void {
  finders.add(finder)
  return () => {
    finders.delete(finder)
  }
}

/** The open modal on top, if any; a chat behind it takes no keys. */
function topModal(): Element | null {
  return (
    [...document.querySelectorAll<HTMLElement>('[aria-modal="true"]')].filter((el) => el.checkVisibility()).at(-1) ??
    null
  )
}

function pick(target: ChatSearchTarget | undefined, scope: Element | null = null): Finder | undefined {
  const shown = [...finders].filter((finder) => {
    const root = finder.root()
    return root?.isConnected === true && (scope === null || scope.contains(root))
  })
  if (target !== undefined) {
    return shown.find((finder) => finder.target === target)
  }
  const focused = document.activeElement
  return (
    shown.find((finder) => focused !== null && finder.root()?.contains(focused) === true) ??
    shown.find((finder) => finder.target === 'agent') ??
    shown.at(0)
  )
}

/** The shown chat whose element holds `node` or lies inside it, as a Vim mode panel does. */
export function chatSearchIn(node: Element): Pick<Finder, 'open' | 'isOpen' | 'step' | 'close'> | null {
  for (const finder of finders) {
    const root = finder.root()
    if (root?.isConnected === true && (root.contains(node) || node.contains(root))) {
      return finder
    }
  }
  return null
}

/** Opens find in `target`, else the chat holding focus, else the agent; false when none shows. */
export function openChatSearch(target?: ChatSearchTarget): boolean {
  const finder = pick(target)
  finder?.open()
  return finder !== undefined
}

const APPLE = /Mac|iPhone|iPad/u

type FindStroke = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>

/** How the find key reads on this device. */
export const FIND_SHORTCUT = APPLE.test(navigator.userAgent) ? 'Cmd+F' : 'Ctrl+F'

/** Ctrl+F, or Cmd+F on Apple devices. */
export function isFindShortcut(e: FindStroke, apple = APPLE.test(navigator.userAgent)): boolean {
  return e.key.toLowerCase() === 'f' && !e.altKey && !e.shiftKey && (apple ? e.metaKey : e.ctrlKey)
}

/** Ctrl+F opens find in the chat on screen; elsewhere the browser's own find runs. */
export function startFindShortcut(): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.defaultPrevented || !isFindShortcut(e)) {
      return
    }
    const finder = pick(undefined, topModal())
    if (finder !== undefined) {
      e.preventDefault()
      finder.open()
    }
  }
  window.addEventListener('keydown', onKeyDown)
  return () => {
    window.removeEventListener('keydown', onKeyDown)
  }
}
