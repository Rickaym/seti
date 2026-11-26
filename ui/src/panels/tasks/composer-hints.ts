import { useLayoutEffect, useState, type RefObject } from 'react'

/** Placeholder hints by state, as [roomy, compact]; a phone's compact one fits one line. */
export const HINTS = {
  idle: [
    'Enter sends, Ctrl+Enter adds a line, Esc Esc rewinds. Start with / for a command or ! to run a shell command here.',
    'Enter sends, Ctrl+Enter adds a line. / commands, ! shell',
  ],
  touchIdle: ['Start with / for a command or ! to run a shell command here.', '/ command, ! shell'],
  noRewindIdle: [
    'Enter sends, Ctrl+Enter adds a line. Start with / for a command or ! to run a shell command here.',
    'Enter sends. / commands, ! shell',
  ],
  busy: [
    'Enter queues it for the agent, Alt+Enter interrupts and sends. Esc stops it.',
    'Enter queues, Alt+Enter interrupts, Esc stops.',
  ],
  touchBusy: ['Send queues it for the agent; Interrupt stops the turn and sends.', 'Send queues it'],
  compacting: [
    'Compacting the conversation. Messages you send now queue until it finishes. Esc stops it.',
    'Compacting. Enter queues, Esc stops.',
  ],
  touchCompacting: [
    'Compacting the conversation. Messages you send now queue until it finishes. Stop ends it.',
    'Compacting; Send queues',
  ],
  shell: ['Esc stops the shell command.', 'Esc stops the shell command.'],
  touchShell: ['Stop ends the shell command.', 'Stop ends it'],
} as const satisfies Record<string, readonly [string, string]>

/** Below this composer width the roomy hints wrap past two lines, so the compact ones show. */
export const ROOMY_PX = 600

interface ComposerState {
  agentRunning: boolean
  compacting: boolean
  shellRunning: boolean
  /** The agent's runtime can go back to an earlier prompt. */
  rewind: boolean
}

/** Touch screens get the same hints without keyboard shortcuts. */
export function hintKey(
  { agentRunning, compacting, shellRunning, rewind }: ComposerState,
  touch: boolean,
): keyof typeof HINTS {
  if (compacting) {
    return touch ? 'touchCompacting' : 'compacting'
  }
  if (agentRunning) {
    return touch ? 'touchBusy' : 'busy'
  }
  if (shellRunning) {
    return touch ? 'touchShell' : 'shell'
  }
  if (touch) {
    return 'touchIdle'
  }
  return rewind ? 'idle' : 'noRewindIdle'
}

/** True while the element is at least `px` wide; re-renders only when that flips. */
export function useWiderThan(element: RefObject<HTMLElement | null>, px: number): boolean {
  const [wider, setWider] = useState(false)
  useLayoutEffect(() => {
    const target = element.current
    if (target === null) {
      return undefined
    }
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined) {
        setWider(entry.contentRect.width >= px)
      }
    })
    observer.observe(target)
    return () => {
      observer.disconnect()
    }
  }, [element, px])
  return wider
}
