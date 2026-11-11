import type { Terminal } from '@xterm/xterm'
import { useEffect, useImperativeHandle, useRef, type RefObject } from 'react'
import { Textarea } from '@/components/ui/textarea'
import { TerminalKeys } from './TerminalKeys'
import { bindInputLine, type InputLine } from './input-line'
import { pasteClipboard } from './terminal-clipboard'
import { keySequence } from './terminal-keys'
import type { LineControl, Modifiers } from './useTouchInput'

interface TerminalLineProps {
  ref: RefObject<LineControl | null>
  term: Terminal
  send: (data: string) => void
  modifiers: Modifiers
  primary: boolean
}

/**
 * The field a touch screen types into, in place of xterm's hidden textarea: a phone keyboard
 * composes, corrects and dictates in it as in any text field, and the shell gets the result.
 * It is a one-row textarea because Chrome on Android shows its autofill bar over text inputs.
 */
function TerminalLine({ ref, term, send, modifiers, primary }: TerminalLineProps) {
  const field = useRef<HTMLTextAreaElement>(null)
  const line = useRef<InputLine | null>(null)
  const { now, release } = modifiers

  useEffect(() => {
    const input = field.current
    if (input === null) {
      return undefined
    }
    const bound = bindInputLine(input, {
      send,
      paste: (text) => {
        term.paste(text)
      },
      held: now,
      release,
      applicationCursor: () => term.modes.applicationCursorKeysMode,
    })
    line.current = bound
    return () => {
      line.current = null
      bound.teardown()
    }
  }, [term, send, now, release])

  useImperativeHandle(
    ref,
    () => ({
      focus: () => {
        field.current?.focus()
      },
      settle: () => {
        line.current?.settle()
      },
    }),
    [],
  )

  return (
    <div className="shrink-0 border-t border-border p-1">
      <Textarea
        ref={field}
        rows={1}
        wrap="off"
        aria-label="Shell input"
        placeholder="Type here"
        autoCapitalize="none"
        autoComplete="off"
        enterKeyHint="enter"
        data-primary-input={primary}
        className="field-sizing-fixed block h-11 min-h-0 resize-none overflow-x-auto overflow-y-hidden py-2.5 [scrollbar-width:none] font-mono text-base leading-5.5 md:text-base"
      />
    </div>
  )
}

interface TerminalInputsProps extends TerminalLineProps {
  /** Shows the input line, as touch screens type through it. */
  lined: boolean
  /** Shows the row of keys a phone keyboard lacks. */
  keys: boolean
  focusInput: () => void
}

/** What a terminal types through below its screen: the input line and the key row. */
export function TerminalInputs({ lined, keys, focusInput, ...line }: TerminalInputsProps) {
  const { ref, term, send, modifiers } = line
  return (
    <>
      {lined && <TerminalLine {...line} />}
      {keys && (
        <TerminalKeys
          held={modifiers.held}
          onModifier={(modifier) => {
            modifiers.toggle(modifier)
            focusInput()
          }}
          onKey={(key) => {
            ref.current?.settle()
            send(keySequence(key, term.modes.applicationCursorKeysMode, modifiers.take()))
            focusInput()
          }}
          onPaste={() => {
            ref.current?.settle()
            void pasteClipboard(term)
            focusInput()
          }}
        />
      )}
    </>
  )
}
