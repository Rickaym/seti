import { Registry } from '@seti/shared'
import { useEffect, type ComponentType } from 'react'

/** Keyboard behaviour added on top of Seti's own keys, such as Vim mode; bundled code only. */
export interface InputHook {
  /** Unique, such as `<mod>.<hook>`. */
  key: string
  onKeyDown?: (e: KeyboardEvent) => void
  takesEscape?: (e: KeyboardEvent) => boolean
  takesTerminalKey?: (e: KeyboardEvent) => boolean
  onFindEnter?: (field: HTMLElement, e: { shiftKey: boolean }) => boolean
  /** Drawn above the page while the hook is registered, such as a list of its keys. */
  overlay?: ComponentType
}

export const inputHooks = new Registry<InputHook>('input hook', (hook) => hook.key)

/** Whether a hook takes this Esc, so Seti's own Esc handlers, such as stopping an agent, skip it. */
export const hookTakesEscape = (e: KeyboardEvent): boolean =>
  inputHooks.list().some((hook) => hook.takesEscape?.(e) === true)

/** Whether a hook takes this key pressed in a terminal, so the terminal leaves it to the page. */
export const hookTakesTerminalKey = (e: KeyboardEvent): boolean =>
  inputHooks.list().some((hook) => hook.takesTerminalKey?.(e) === true)

/** Whether a hook took Enter in a chat's find field, instead of stepping to the next match. */
export const hookTakesFindEnter = (field: HTMLElement, e: { shiftKey: boolean }): boolean =>
  inputHooks.list().some((hook) => hook.onFindEnter?.(field, e) === true)

/** Hands every keydown no one claimed to each hook in turn, until one claims it. */
export function useInputHookKeys(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      for (const hook of inputHooks.list()) {
        if (e.defaultPrevented) {
          return
        }
        hook.onKeyDown?.(e)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [])
}
