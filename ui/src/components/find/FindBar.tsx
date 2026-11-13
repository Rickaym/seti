import {
  CaseSensitive,
  ChevronDown,
  ChevronUp,
  CornerDownLeft,
  Hash,
  Replace,
  ReplaceAll,
  Search,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { Hint } from '@/components/Hint'
import { ToggleButton } from '@/components/ToggleButton'
import { TEXT_KEYS, textFindKey } from '@/components/find/find-keys'
import type { FindState } from '@/components/find/useFind'
import { useEscapeClosesFind } from '@/components/find/useFindKeys'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { findCountLabel } from '@/lib/text-find'
import { cn } from '@/lib/utils'

/** What the field is called and the test id of the bar; its count's id adds `-count`. */
interface Naming {
  label: string
  testId: string
}

const FIELD = 'h-7 min-w-0 flex-1 border-none bg-transparent focus-visible:ring-0 dark:bg-transparent'

/** Stepping by mouse leaves focus in the field, so Enter keeps stepping and typing keeps editing. */
const keepTyping = (e: MouseEvent) => {
  e.preventDefault()
}

function IconButton({
  hint,
  label,
  onClick,
  disabled = false,
  children,
}: {
  hint: string
  label: string
  onClick: () => void
  disabled?: boolean
  children: ReactNode
}) {
  return (
    <Hint text={hint}>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={label}
        disabled={disabled}
        onMouseDown={keepTyping}
        onClick={onClick}
      >
        {children}
      </Button>
    </Hint>
  )
}

/** Focuses and selects the field each time find is asked to open. */
function useFocusField(focusRequest: number) {
  const field = useRef<HTMLInputElement>(null)
  useEffect(() => {
    field.current?.focus()
    field.current?.select()
  }, [focusRequest])
  return field
}

function FindRow({ find, editable, label, testId }: { find: FindState; editable: boolean } & Naming) {
  const field = useFocusField(find.focusRequest)
  const none = find.count === null || find.count.total === 0
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (e.shiftKey) {
        find.target.current?.previous()
      } else {
        find.target.current?.next()
      }
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-1">
      <div className="flex min-w-40 flex-1 items-center gap-1">
        <Search className="size-3.5 shrink-0 text-muted-foreground" />
        <Input
          ref={field}
          type="search"
          value={find.text}
          placeholder={label}
          aria-label={label}
          className={FIELD}
          onChange={(e) => {
            find.setText(e.target.value)
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      <div className="ml-auto flex items-center gap-1">
        <span
          aria-live="polite"
          data-testid={`${testId}-count`}
          className="shrink-0 text-2xs text-muted-foreground tabular-nums"
        >
          {findCountLabel(find.text, find.count)}
        </span>
        <ToggleButton
          pressed={find.caseSensitive}
          onPressedChange={find.setCaseSensitive}
          icon={CaseSensitive}
          label="Match case"
          iconOnly
          variant="ghost"
          hint="Match upper and lower case exactly"
        />
        <IconButton
          hint={`Previous match (Shift+Enter, ${TEXT_KEYS.previous})`}
          label="Previous match"
          disabled={none}
          onClick={() => find.target.current?.previous()}
        >
          <ChevronUp />
        </IconButton>
        <IconButton
          hint={`Next match (Enter, ${TEXT_KEYS.next})`}
          label="Next match"
          disabled={none}
          onClick={() => find.target.current?.next()}
        >
          <ChevronDown />
        </IconButton>
        {editable && (
          <ToggleButton
            pressed={find.mode === 'replace'}
            onPressedChange={(on) => {
              find.open(on ? 'replace' : 'find')
            }}
            icon={Replace}
            label="Replace"
            iconOnly
            variant="ghost"
            hint={`Replace matches (${TEXT_KEYS.replace})`}
          />
        )}
        <IconButton hint="Close find (Esc)" label="Close find" onClick={find.close}>
          <X />
        </IconButton>
      </div>
    </div>
  )
}

function ReplaceRow({ find }: { find: FindState }) {
  const none = find.count === null || find.count.total === 0
  const one = () => find.target.current?.replace?.(find.replacement)
  return (
    <div className="flex items-center gap-1">
      <Replace className="size-3.5 shrink-0 text-muted-foreground" />
      <Input
        value={find.replacement}
        placeholder="Replace with"
        aria-label="Replace with"
        className={FIELD}
        onChange={(e) => {
          find.setReplacement(e.target.value)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            one()
          }
        }}
      />
      <Hint text="Replace this match and go to the next (Enter)">
        <Button variant="outline" size="sm" disabled={none} onMouseDown={keepTyping} onClick={one}>
          <Replace />
          Replace
        </Button>
      </Hint>
      <Hint text="Replace every match">
        <Button
          variant="outline"
          size="sm"
          disabled={none}
          onMouseDown={keepTyping}
          onClick={() => find.target.current?.replaceAll?.(find.replacement)}
        >
          <ReplaceAll />
          All
        </Button>
      </Hint>
    </div>
  )
}

function LineRow({ find, text }: { find: FindState; text: string }) {
  const field = useFocusField(find.focusRequest)
  const lines = useMemo(() => text.split('\n').length, [text])
  const [value, setValue] = useState('')
  const line = Number(value)
  const valid = /^\d+$/u.test(value) && line >= 1 && line <= lines
  const go = () => {
    if (valid) {
      find.target.current?.goToLine?.(line)
      find.close()
    }
  }
  return (
    <div className="flex items-center gap-1">
      <Hash className="size-3.5 shrink-0 text-muted-foreground" />
      <Input
        ref={field}
        inputMode="numeric"
        value={value}
        placeholder={`Line, 1 to ${String(lines)}`}
        aria-label="Go to line"
        aria-invalid={value !== '' && !valid}
        className={FIELD}
        onChange={(e) => {
          setValue(e.target.value.trim())
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            go()
          }
        }}
      />
      <Hint text="Go to the line (Enter)">
        <Button variant="outline" size="sm" disabled={!valid} onClick={go}>
          <CornerDownLeft />
          Go
        </Button>
      </Hint>
      <IconButton hint="Close (Esc)" label="Close go to line" onClick={find.close}>
        <X />
      </IconButton>
    </div>
  )
}

/** Find keys pressed in the bar, for a bar that sits outside its text's box. */
function barKey(e: KeyboardEvent<HTMLDivElement>, find: FindState, editable: boolean): void {
  if (e.defaultPrevented) {
    return
  }
  const action = textFindKey(e.nativeEvent)
  if (action === null || action === 'line' || (action === 'replace' && !editable)) {
    return
  }
  e.preventDefault()
  if (action === 'next' || action === 'previous') {
    find.target.current?.[action]()
  } else {
    find.open(action)
  }
}

interface FindBarProps extends Naming {
  find: FindState
  editable: boolean
  /** The text whose lines go to line reaches. */
  text?: string | undefined
  className?: string
}

/** Find, replace or go to line in a text, beside it while open. */
export function FindBar(props: FindBarProps) {
  return props.find.mode === null ? null : <OpenBar {...props} />
}

function OpenBar({ find, editable, text = '', label, testId, className }: FindBarProps) {
  const [bar, setBar] = useState<HTMLDivElement | null>(null)
  useEscapeClosesFind(bar, find)
  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- keys from its fields
    <div
      ref={setBar}
      role="search"
      data-testid={testId}
      className={cn('flex shrink-0 flex-col gap-1 border-border bg-card px-3 py-1.5', className)}
      onKeyDown={(e) => {
        barKey(e, find, editable)
      }}
    >
      {find.mode === 'line' ? (
        <LineRow find={find} text={text} />
      ) : (
        <>
          <FindRow find={find} editable={editable} label={label} testId={testId} />
          {editable && find.mode === 'replace' && <ReplaceRow find={find} />}
        </>
      )}
    </div>
  )
}

/** Find and replace in a message box, laid across its composer above the box. */
export function MessageFindBar({ find, editable }: { find: FindState; editable: boolean }) {
  return <FindBar find={find} editable={editable} label="Find in message" testId="message-find" className="border" />
}

/** Find and replace, and go to line where the text offers it, laid on top of a text field. */
export function TextFindBar({ find, editable, text }: { find: FindState; editable: boolean; text?: string }) {
  return (
    <FindBar
      find={find}
      editable={editable}
      text={text}
      label="Find in text"
      testId="text-find"
      className="border border-b-0"
    />
  )
}
