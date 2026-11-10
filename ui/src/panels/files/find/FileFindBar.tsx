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
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { findCountLabel } from '@/lib/text-find'
import { FILE_KEYS } from '@/panels/files/find/find-keys'
import type { FileFind } from '@/panels/files/find/useFileFind'

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

function FindRow({ find, editable }: { find: FileFind; editable: boolean }) {
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
    } else if (e.key === 'Escape') {
      e.preventDefault()
      find.close()
    }
  }
  return (
    <div className="flex items-center gap-1">
      <Search className="size-3.5 shrink-0 text-muted-foreground" />
      <Input
        ref={field}
        type="search"
        value={find.text}
        placeholder="Find in file"
        aria-label="Find in file"
        className={FIELD}
        onChange={(e) => {
          find.setText(e.target.value)
        }}
        onKeyDown={onKeyDown}
      />
      <span
        aria-live="polite"
        data-testid="file-find-count"
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
        hint={`Previous match (Shift+Enter, ${FILE_KEYS.previous})`}
        label="Previous match"
        disabled={none}
        onClick={() => find.target.current?.previous()}
      >
        <ChevronUp />
      </IconButton>
      <IconButton
        hint={`Next match (Enter, ${FILE_KEYS.next})`}
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
          hint={`Replace matches (${FILE_KEYS.replace})`}
        />
      )}
      <IconButton hint="Close find (Esc)" label="Close find" onClick={find.close}>
        <X />
      </IconButton>
    </div>
  )
}

function ReplaceRow({ find }: { find: FileFind }) {
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
          } else if (e.key === 'Escape') {
            e.preventDefault()
            find.close()
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

function LineRow({ find, text }: { find: FileFind; text: string }) {
  const field = useFocusField(find.focusRequest)
  const lines = useMemo(() => text.split('\n').length, [text])
  const [value, setValue] = useState('')
  const line = Number(value)
  const valid = /^\d+$/u.test(value) && line >= 1 && line <= lines
  const go = () => {
    if (valid) {
      find.target.current?.goToLine(line)
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
          } else if (e.key === 'Escape') {
            e.preventDefault()
            find.close()
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

/** Find, replace or go to line in the open file, above its text while open. */
export function FileFindBar({
  find,
  editable,
  text,
}: {
  find: FileFind
  editable: boolean
  /** The file's text, whose lines go to line reaches. */
  text: string
}) {
  if (find.mode === null) {
    return null
  }
  return (
    <div
      role="search"
      data-testid="file-find"
      className="flex shrink-0 flex-col gap-1 border-b border-border bg-card px-3 py-1.5"
    >
      {find.mode === 'line' ? (
        <LineRow find={find} text={text} />
      ) : (
        <>
          <FindRow find={find} editable={editable} />
          {editable && find.mode === 'replace' && <ReplaceRow find={find} />}
        </>
      )}
    </div>
  )
}
