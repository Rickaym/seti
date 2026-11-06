import type { MessageRow, OwnMessageStep } from '@seti/shared'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { toast } from 'sonner'
import { errorText } from '@/api'
import {
  olderOwn,
  ownMove,
  ownNav,
  READ_LINE,
  sameNav,
  type OwnDirection,
  type OwnNav,
  type OwnView,
} from '@/lib/own-messages'
import { registerOwnSteps } from '@/panels/tasks/own-steps'

const OWN = '[data-own-message]'
/** Marks the message a step landed on; its outline fades out in CSS while the mark stays. */
const FLASH = 'data-own-flash'
/** Earlier pages one step loads at most while looking for an own message. */
const MAX_PAGES = 10

const HIDDEN: OwnNav = { show: false, back: null, forward: null, position: null }

interface OwnMessagesOptions {
  scroller: RefObject<HTMLElement | null>
  content: RefObject<HTMLElement | null>
  messages: readonly MessageRow[]
  hasOlder: boolean
  loadingOlder: boolean
  /** Loads `limit` rows before the oldest row, keeping the view still; null when none starts. */
  requestOlder: (limit?: number) => Promise<boolean> | null
  /** Loads `limit` rows after a stretch far back; null when none starts. */
  requestNewer: (limit: number) => Promise<boolean> | null
  /** The view shows a stretch far back rather than the newest messages. */
  detached: boolean
  jumpTo?: ((id: number) => Promise<void>) | undefined
  /** Finds own messages past the loaded rows; without it a step walks earlier pages instead. */
  findOwn?: ((direction: OwnDirection, from: number) => Promise<OwnMessageStep>) | undefined
  /** Stops following new messages, so a step's position holds. */
  unstick: () => void
  /** Shows the newest messages and follows them again. */
  toLatest: () => void
  /** The view shows the newest messages at its bottom. */
  atLatest: () => boolean
}

/** A step walking earlier pages until one holds an own message. */
interface Walk {
  kind: 'walk'
  oldest: number
  pages: number
  /** A load that was already running carries the step, so its own promise is not ours. */
  borrowed: boolean
}

/** A step waiting for the own message the server found to load, or for the server's answer. */
interface Target {
  kind: 'target'
  id: number | null
  direction: OwnDirection
  /** A load that was already running took the step's place; once it lands, the step asks again. */
  borrowed: boolean
  /** Its load finished, so the next render without the message ends the step. */
  settled: boolean
}

type Seek = Walk | Target

interface Measured {
  nodes: HTMLElement[]
  view: OwnView
}

/** The own message a step waits for, once it is loaded. */
function foundNode(content: HTMLElement | null, pending: Seek | null): HTMLElement | null {
  if (content === null || pending?.kind !== 'target' || pending.id === null) {
    return null
  }
  return content.querySelector<HTMLElement>(`[data-own-message="${String(pending.id)}"]`)
}

/** Steps back and forward through the user's own messages, loading earlier ones as needed. */
export function useOwnMessages(options: OwnMessagesOptions) {
  const latest = useRef(options)
  useLayoutEffect(() => {
    latest.current = options
  })
  const cursor = useRef<{ id: string; top: number } | null>(null)
  const seek = useRef<Seek | null>(null)
  const flashed = useRef<HTMLElement | null>(null)
  /** A loaded edge the server said no own message lies before. */
  const noneBefore = useRef<number | null>(null)
  const [nav, setNav] = useState<OwnNav>(HIDDEN)
  const [seeking, setSeeking] = useState<OwnDirection | null>(null)
  /** Renders once a load settles, after the rows it added, so its step lands or ends. */
  const [settles, setSettles] = useState(0)

  const measure = useCallback((): Measured | null => {
    const { scroller, content, messages, hasOlder, findOwn, atLatest } = latest.current
    const el = scroller.current
    const inner = content.current
    if (el === null || inner === null) {
      return null
    }
    const nodes = [...inner.querySelectorAll<HTMLElement>(OWN)]
    const edge = el.getBoundingClientRect().top
    const rects = nodes.map((node) => node.getBoundingClientRect())
    const mark = cursor.current
    const index = mark === null ? -1 : nodes.findIndex((node) => node.dataset.ownMessage === mark.id)
    const view: OwnView = {
      tops: rects.map((rect) => rect.top - edge),
      bottoms: rects.map((rect) => rect.bottom - edge),
      height: el.clientHeight,
      cursor: mark === null || index < 0 ? null : { index, top: mark.top },
      hasOlder: olderOwn(hasOlder, messages[0]?.id, noneBefore.current),
      indexed: findOwn !== undefined,
      atLatest: atLatest(),
    }
    const next = ownNav(view)
    setNav((prev) => (sameNav(prev, next) ? prev : next))
    return { nodes, view }
  }, [])

  const flash = useCallback((node: HTMLElement) => {
    if (flashed.current === node) {
      for (const animation of node.getAnimations()) {
        animation.currentTime = 0
        animation.play()
      }
      return
    }
    flashed.current?.removeAttribute(FLASH)
    node.setAttribute(FLASH, '')
    flashed.current = node
  }, [])

  const land = useCallback(
    (node: HTMLElement) => {
      const el = latest.current.scroller.current
      if (el === null) {
        return
      }
      latest.current.unstick()
      const edge = () => el.getBoundingClientRect().top
      el.scrollTop += node.getBoundingClientRect().top - edge() - READ_LINE
      cursor.current = { id: node.dataset.ownMessage ?? '', top: node.getBoundingClientRect().top - edge() }
      flash(node)
      measure()
    },
    [flash, measure],
  )

  const stopSeeking = useCallback(() => {
    seek.current = null
    setSeeking(null)
  }, [])

  const startSeeking = useCallback((direction: OwnDirection, pending: Seek) => {
    latest.current.unstick()
    seek.current = pending
    setSeeking(direction)
  }, [])

  const toLatest = useCallback(() => {
    stopSeeking()
    cursor.current = null
    latest.current.toLatest()
  }, [stopSeeking])

  /** Lands on the message the server found once it is loaded; false while it is not. */
  const landFound = useCallback((): boolean => {
    const node = foundNode(latest.current.content.current, seek.current)
    if (node === null) {
      return false
    }
    stopSeeking()
    land(node)
    return true
  }, [land, stopSeeking])

  /** Loads the rows from the loaded edge to the found message, or the stretch around it if far. */
  const reach = useCallback(
    (direction: OwnDirection, from: number, found: OwnMessageStep) => {
      if (found.id === null && direction === 'forward') {
        toLatest()
        return
      }
      if (found.id === null) {
        noneBefore.current = from
        stopSeeking()
        measure()
        return
      }
      const pending: Seek = { kind: 'target', id: found.id, direction, borrowed: false, settled: false }
      seek.current = pending
      if (landFound()) {
        return
      }
      const { requestOlder, requestNewer, jumpTo, loadingOlder } = latest.current
      const extend = direction === 'back' ? requestOlder : requestNewer
      const load = found.reach === null ? (jumpTo?.(found.id) ?? null) : extend(found.reach)
      if (load === null) {
        if (direction === 'back' && loadingOlder) {
          seek.current = { kind: 'target', id: found.id, direction, borrowed: true, settled: false }
        } else {
          stopSeeking()
        }
        return
      }
      void load.then(() => {
        if (seek.current === pending) {
          pending.settled = true
          setSettles((count) => count + 1)
        }
      })
    },
    [landFound, measure, stopSeeking, toLatest],
  )

  /** Asks the server for the nearest own message past the loaded rows, then loads it. */
  const find = useCallback(
    (direction: OwnDirection) => {
      const { messages, findOwn } = latest.current
      const from = direction === 'back' ? messages[0]?.id : messages.at(-1)?.id
      if (findOwn === undefined || from === undefined) {
        stopSeeking()
        return
      }
      const pending: Seek = { kind: 'target', id: null, direction, borrowed: false, settled: false }
      startSeeking(direction, pending)
      findOwn(direction, from)
        .then((found) => {
          if (seek.current === pending) {
            reach(direction, from, found)
          }
        })
        .catch((e: unknown) => {
          stopSeeking()
          toast.error(errorText(e))
        })
    },
    [reach, startSeeking, stopSeeking],
  )

  const loadEarlier = useCallback(
    (pages: number) => {
      const { messages, requestOlder } = latest.current
      const load = requestOlder()
      startSeeking('back', { kind: 'walk', oldest: messages[0]?.id ?? 0, pages, borrowed: load === null })
      void load?.then((added) => {
        if (!added) {
          stopSeeking()
        }
      })
    },
    [startSeeking, stopSeeking],
  )

  const step = useCallback(
    (direction: OwnDirection, pages = MAX_PAGES) => {
      const measured = measure()
      const target = measured === null ? null : ownNav(measured.view)[direction]
      const { findOwn, detached } = latest.current
      const move = ownMove(target, { indexed: findOwn !== undefined, detached, pages })
      const node = typeof target === 'number' ? measured?.nodes[target] : undefined
      if (move === 'land' && node !== undefined) {
        stopSeeking()
        land(node)
      } else if (move === 'find') {
        find(direction)
      } else if (move === 'walk') {
        loadEarlier(pages)
      } else if (move === 'latest') {
        toLatest()
      } else {
        stopSeeking()
      }
    },
    [measure, land, find, loadEarlier, stopSeeking, toLatest],
  )

  /** Lands a found message once loaded; a load that missed it ends the step or asks again. */
  const settleTarget = useCallback(
    (pending: Target) => {
      if (landFound()) {
        return
      }
      if (pending.settled) {
        stopSeeking()
      } else if (pending.borrowed && !latest.current.loadingOlder) {
        find(pending.direction)
      }
    },
    [landFound, stopSeeking, find],
  )

  /** A press while an earlier one still loads does nothing, so repeats cannot pile up. */
  const press = useCallback(
    (direction: OwnDirection) => {
      if (seek.current === null) {
        step(direction)
      }
    },
    [step],
  )

  const { messages, loadingOlder } = options
  useLayoutEffect(() => {
    const pending = seek.current
    if (pending?.kind === 'target') {
      settleTarget(pending)
    } else if (pending !== null && (messages[0]?.id ?? 0) < pending.oldest) {
      step('back', pending.pages - 1)
    } else if (pending?.borrowed === true && !loadingOlder) {
      stopSeeking()
    }
    measure()
  }, [messages, loadingOlder, settles, step, measure, stopSeeking, settleTarget])

  useEffect(() => {
    const { scroller, content } = latest.current
    const el = scroller.current
    const inner = content.current
    if (el === null || inner === null) {
      return undefined
    }
    let frame: number | null = null
    const schedule = () => {
      frame ??= requestAnimationFrame(() => {
        frame = null
        measure()
      })
    }
    el.addEventListener('scroll', schedule, { passive: true })
    const observer = new ResizeObserver(schedule)
    observer.observe(inner)
    observer.observe(el)
    const unregister = registerOwnSteps({
      root: () => scroller.current,
      hasOwn: () =>
        (content.current?.querySelector(OWN) ?? null) !== null ||
        (latest.current.findOwn !== undefined && latest.current.hasOlder),
      step: press,
    })
    return () => {
      unregister()
      el.removeEventListener('scroll', schedule)
      observer.disconnect()
      if (frame !== null) {
        cancelAnimationFrame(frame)
      }
    }
  }, [measure, press])

  return { nav, seeking, step: press }
}
