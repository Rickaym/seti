import { parseComposer, pasteGoesToFile, rankCommands, type ComposerCheck, type ComposerCommand } from '@seti/shared'
import { useId, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react'
import { FindableTextarea } from '@/components/find/FindableTextarea'
import type { FindState } from '@/components/find/useFind'
import { useEditorText } from '@/hooks/useEditorText'
import type { CommandState } from '@/lib/command-catalog'
import { handleWordDelete, insertText } from '@/lib/text-edit'
import { cn } from '@/lib/utils'
import { SuggestionList } from '@/panels/tasks/CommandSuggestions'

const SUGGESTION_LIMIT = 8

interface CommandFieldProps {
  value: string
  onChange: (value: string) => void
  commands: CommandState
  label: string
  placeholder: string
  rows: number
  disabled?: boolean
  /** Where the suggestion list opens relative to the box. */
  placement: 'above' | 'below'
  /** Plain Enter with `enterSends`, otherwise Ctrl+Enter or Cmd+Enter. */
  onSubmit?: () => void
  /** Enter submits and Ctrl+Enter or Shift+Enter starts a new line, as in Claude Code. */
  enterSends?: boolean
  /** Alt+Enter, the second way to send when there is one. */
  onAltSubmit?: (() => void) | undefined
  /** Takes big pastes and pasted or dropped files as attachments; each returns the tokens to insert. */
  attach?: AttachHandlers | undefined
  /** The page's main input, which takes focus after keyboard navigation to the page. */
  primary?: boolean
  /** Find and replace in the box, opened by Ctrl+F there or a Find button; the page shows the bar. */
  find: FindState
  className?: string
}

export interface AttachHandlers {
  text: (text: string) => string
  files: (files: readonly File[]) => string[]
}

/** What Enter does with these modifiers; null leaves the key to the textarea. */
function enterAction(e: KeyboardEvent<HTMLTextAreaElement>, enterSends: boolean): 'submit' | 'newline' | 'alt' | null {
  if (e.key !== 'Enter' || e.nativeEvent.isComposing) {
    return null
  }
  if (e.altKey) {
    return 'alt'
  }
  const modified = e.ctrlKey || e.metaKey
  if (!enterSends) {
    return modified ? 'submit' : null
  }
  if (modified) {
    return 'newline'
  }
  return e.shiftKey ? null : 'submit'
}

/** Puts text at the caret with a space on either side where it would touch a word. */
function insertAtCaret(field: HTMLTextAreaElement, text: string): void {
  const { selectionStart, selectionEnd, value } = field
  const lead = selectionStart === 0 || /\s/.test(value.charAt(selectionStart - 1)) ? '' : ' '
  const tail = /^\s/.test(value.slice(selectionEnd)) ? '' : ' '
  insertText(field, `${lead}${text}${tail}`)
}

/** What a paste turns into: tokens of attachments, or null to paste the text as it is. */
function pastedTokens(e: ClipboardEvent<HTMLTextAreaElement>, attach: AttachHandlers): string | null {
  const text = e.clipboardData.getData('text/plain')
  const files = [...e.clipboardData.files]
  if (text === '' && files.length > 0) {
    return attach.files(files).join(' ')
  }
  return pasteGoesToFile(text) ? attach.text(text) : null
}

const carriesFiles = (e: DragEvent) => e.dataTransfer.types.includes('Files')

/** Paste and drop handlers that turn big pastes and files into attachment tokens at the caret. */
function useAttachInput(attach: AttachHandlers | undefined, disabled: boolean) {
  const [dragging, setDragging] = useState(false)
  const takes = (e: DragEvent) => attach !== undefined && !disabled && carriesFiles(e)
  return {
    dropClass: dragging ? 'outline-2 outline-primary outline-dashed' : undefined,
    onPaste: (e: ClipboardEvent<HTMLTextAreaElement>) => {
      const tokens = attach === undefined ? null : pastedTokens(e, attach)
      if (tokens !== null) {
        e.preventDefault()
        insertAtCaret(e.currentTarget, tokens)
      }
    },
    onDragOver: (e: DragEvent<HTMLTextAreaElement>) => {
      if (takes(e)) {
        e.preventDefault()
        setDragging(true)
      }
    },
    onDragLeave: () => {
      setDragging(false)
    },
    onDrop: (e: DragEvent<HTMLTextAreaElement>) => {
      setDragging(false)
      if (attach !== undefined && takes(e)) {
        e.preventDefault()
        insertAtCaret(e.currentTarget, attach.files([...e.dataTransfer.files]).join(' '))
      }
    },
  }
}

/** A textarea that suggests slash commands while the first word is typed. */
export function CommandField(props: CommandFieldProps) {
  const { value, onChange, commands, placement, onSubmit, onAltSubmit, attach, find, disabled = false } = props
  const { dropClass, ...attachInput } = useAttachInput(attach, disabled)
  const { ref: editorRef, ...editor } = useEditorText(value, onChange)
  const listId = useId()
  const [active, setActive] = useState(0)
  const [dismissedAt, setDismissedAt] = useState<string | null>(null)
  const [focused, setFocused] = useState(false)
  const input = parseComposer(value)
  const typingName = input.mode === 'slash' && !/\s/.test(value.trimStart())
  const items = typingName ? rankCommands(commands.commands ?? [], input.name, SUGGESTION_LIMIT) : []
  const hasList = items.length > 0 || commands.loading || commands.commands !== null
  const open = typingName && focused && !disabled && dismissedAt !== value && hasList
  const current = Math.min(active, Math.max(items.length - 1, 0))

  const accept = (command: ComposerCommand) => {
    onChange(`/${command.name} `)
    setActive(0)
  }

  const onListKey = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    const picked = items[current]
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const step = e.key === 'ArrowDown' ? 1 : -1
      setActive((current + step + items.length) % Math.max(items.length, 1))
    } else if ((e.key === 'Enter' || e.key === 'Tab') && !e.ctrlKey && !e.metaKey && !e.shiftKey && picked) {
      accept(picked)
    } else if (e.key === 'Escape') {
      setDismissedAt(value)
    } else {
      return false
    }
    e.preventDefault()
    return true
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((open && onListKey(e)) || handleWordDelete(e)) {
      return
    }
    const action = enterAction(e, props.enterSends === true)
    if (action === 'newline') {
      e.preventDefault()
      insertText(e.currentTarget, '\n')
    } else if (action === 'submit') {
      e.preventDefault()
      onSubmit?.()
    } else if (action === 'alt' && onAltSubmit !== undefined) {
      e.preventDefault()
      onAltSubmit()
    }
  }

  return (
    <div className="relative min-w-0 flex-1">
      <FindableTextarea
        ref={editorRef}
        find={find}
        findText={value}
        rows={props.rows}
        disabled={disabled}
        aria-label={props.label}
        placeholder={props.placeholder}
        data-primary-input={props.primary}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && items.length > 0 ? `${listId}-${String(current)}` : undefined}
        className={cn(
          'max-h-[40dvh] overflow-y-auto',
          props.className,
          input.mode === 'shell' && 'border-shell font-mono focus-visible:border-shell',
          dropClass,
        )}
        onFocus={() => {
          setFocused(true)
        }}
        onBlur={() => {
          editor.onBlur()
          setFocused(false)
        }}
        onChange={(e) => {
          editor.onChange(e)
          setActive(0)
        }}
        onCompositionStart={editor.onCompositionStart}
        onCompositionEnd={editor.onCompositionEnd}
        onKeyDown={onKeyDown}
        {...attachInput}
      />
      {open && (
        <SuggestionList
          listId={listId}
          items={items}
          active={current}
          loading={commands.loading}
          updating={commands.updating}
          placement={placement}
          onPick={accept}
        />
      )}
    </div>
  )
}

type Tone = 'muted' | 'info' | 'warning' | 'error'

const TONE_STYLE: Record<Tone, string> = {
  muted: 'text-muted-foreground',
  info: 'text-muted-foreground',
  warning: 'text-foreground bg-warning/25',
  error: 'text-destructive bg-destructive/10',
}

interface StatusText {
  tone: Tone
  text: string
  badge?: string
}

const refusedBadge = (kind: ComposerCheck['kind']) => (kind === 'shell' ? 'shell' : 'command')

const withArgs = (command: ComposerCommand) =>
  command.argument_hint === '' ? `/${command.name}` : `/${command.name} ${command.argument_hint}`

function slashStatus(check: ComposerCheck, commands: CommandState): StatusText | null {
  switch (check.kind) {
    case 'no-name':
      return { tone: 'muted', text: 'Type a command name, or keep typing to search' }
    case 'unchecked':
      return commands.error === null
        ? { tone: 'muted', text: `Checking /${check.name}...` }
        : { tone: 'warning', text: `Could not load the command list: ${commands.error}` }
    case 'partial':
      return {
        tone: 'muted',
        text: `${String(check.matches)} matching ${check.matches === 1 ? 'command' : 'commands'}: arrows to choose, Tab or Enter to insert`,
      }
    case 'unknown': {
      if (commands.updating) {
        return { tone: 'muted', text: `/${check.name} is not in the list yet; updating it...` }
      }
      const hint = check.suggestion === null ? '' : ` Did you mean /${check.suggestion}?`
      return { tone: 'warning', text: `/${check.name} is not available to this agent.${hint}` }
    }
    case 'unsupported':
      return {
        tone: 'warning',
        text: `/${check.command.name} is not supported in Seti: ${check.command.unsupported ?? ''}`,
      }
    case 'needs-args':
      return { tone: 'warning', text: `/${check.command.name} needs arguments: ${check.command.argument_hint}` }
    case 'command':
      return { tone: 'info', text: `${withArgs(check.command)}  ${check.command.description}`, badge: 'command' }
    case 'text':
    case 'shell':
      return null
  }
}

interface StatusProps {
  check: ComposerCheck
  commands: CommandState
  /** Where `!` commands run, or null when they cannot run here. */
  shellCwd: string | null
  /** What to show when the draft is plain text; nothing shows without it. */
  idle?: string | null
  /** Why the draft cannot be sent right now, shown in place of what it would do. */
  refused?: string | null
  /** What a mod's slash command will do, as its mod says, in place of the catalog's line. */
  action?: string | null
  /** How a send under way is going, such as a retry; shown in place of everything else. */
  progress?: string | null
}

function statusFor(props: StatusProps): StatusText | null {
  const { check, commands, shellCwd, idle = null, refused = null, action = null, progress = null } = props
  if (progress !== null) {
    return { tone: 'muted', text: progress }
  }
  if (refused !== null) {
    return { tone: 'warning', text: refused, badge: refusedBadge(check.kind) }
  }
  if (action !== null) {
    return { tone: 'info', text: action, badge: 'command' }
  }
  const quiet = idle === null ? null : { tone: 'muted' as const, text: idle }
  if (check.kind === 'text') {
    return quiet
  }
  if (check.kind !== 'shell') {
    return slashStatus(check, commands) ?? quiet
  }
  if (shellCwd === null) {
    return {
      tone: 'warning',
      text: 'Shell commands run in an existing agent; the new agent gets this as a message',
      badge: 'shell',
    }
  }
  if (check.issues.length > 0) {
    return { tone: 'error', text: check.issues.join('. '), badge: 'shell' }
  }
  return {
    tone: 'info',
    text: `Runs with bash in ${shellCwd}; the agent sees the output on its next turn`,
    badge: 'shell',
  }
}

/** One line by the box that says what sending the text will do, and what looks wrong. */
export function ComposerStatus(props: StatusProps) {
  const status = statusFor(props)
  if (status === null) {
    return <p role="status" aria-label="Composer status" className="sr-only" />
  }
  return (
    <p
      role="status"
      aria-label="Composer status"
      className={cn('flex min-h-5 items-center gap-2 px-1 text-2xs', TONE_STYLE[status.tone])}
    >
      {status.badge !== undefined && (
        <span className="shrink-0 bg-queued/25 px-1 font-mono text-2xs font-semibold text-foreground uppercase">
          {status.badge}
        </span>
      )}
      <span className="min-w-0 truncate">{status.text}</span>
    </p>
  )
}
