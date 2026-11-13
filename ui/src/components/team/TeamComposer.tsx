import type { TeamMember, TeamPosted, TeamPostInput } from '@seti/shared'
import { Send } from 'lucide-react'
import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { toast } from 'sonner'
import { apiSend, errorText } from '@/api'
import { MessageFindBar } from '@/components/find/FindBar'
import { FindButton } from '@/components/find/FindButton'
import { FindableTextarea } from '@/components/find/FindableTextarea'
import { useFind } from '@/components/find/useFind'
import { Button } from '@/components/ui/button'
import { RETRYING_LABEL, useClientSend } from '@/hooks/useClientSend'
import { useDraft } from '@/hooks/useDraft'
import { useCoarsePointer } from '@/hooks/useMedia'
import { TEAM_CHAT_DRAFT } from '@/lib/drafts'
import { insertMention, mentionAt, rankMentions, type MentionOption } from '@/lib/mentions'
import { handleWordDelete } from '@/lib/text-edit'
import { cn } from '@/lib/utils'

const SUGGESTION_LIMIT = 8

const RESERVED: MentionOption[] = [
  { handle: 'all', detail: 'Every active agent, at its next step', quiet: false },
  { handle: 'ea', detail: 'The EA', quiet: false },
]

const optionsOf = (members: readonly TeamMember[]): MentionOption[] => [
  ...RESERVED,
  ...members.map((member) => ({
    handle: member.handle,
    detail: `${member.title}${member.muted ? ' (muted)' : ''}`,
    quiet: member.muted || !member.active,
  })),
]

/** One line on what the last message did, such as whose running turn it joined. */
function outcomeText(posted: TeamPosted): string {
  const count = (mode: string) => posted.deliveries.filter((d) => d.mode === mode)
  const handles = (mode: string) =>
    count(mode)
      .map((d) => `@${d.handle}`)
      .join(', ')
  const parts = [
    count('now').length > 0 ? `reached ${handles('now')} mid-turn` : null,
    count('start').length > 0 ? `started ${handles('start')}` : null,
    count('next').length > 0 ? `${String(count('next').length)} at their next step` : null,
    count('held').length > 0 ? `${String(count('held').length)} on their next turn` : null,
    count('skipped').length > 0 ? `not sent to ${handles('skipped')}` : null,
    posted.unknown.length > 0 ? `no agent is @${posted.unknown.join(', @')}` : null,
    posted.archived.length > 0 ? `@${posted.archived.join(', @')} archived, restore to reach` : null,
  ].filter((part) => part !== null)
  return parts.length === 0 ? 'Posted' : `Posted: ${parts.join('; ')}`
}

/** The chat box: Enter sends, Shift+Enter starts a new line, @ suggests handles. */
export function TeamComposer({ members }: { members: readonly TeamMember[] }) {
  const touch = useCoarsePointer()
  const [draft, setDraft] = useDraft(TEAM_CHAT_DRAFT)
  const [caret, setCaret] = useState(0)
  const [active, setActive] = useState(0)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const clientSend = useClientSend()
  const box = useRef<HTMLTextAreaElement>(null)
  const find = useFind()
  const listId = useId()
  const options = useMemo(() => optionsOf(members), [members])
  const typing = mentionAt(draft, caret)
  const items = typing === null ? [] : rankMentions(options, typing.query, SUGGESTION_LIMIT)
  const open = typing !== null && items.length > 0 && dismissed !== draft
  const current = Math.min(active, Math.max(items.length - 1, 0))

  const pick = (option: MentionOption) => {
    if (typing === null) {
      return
    }
    const next = insertMention(draft, typing.start, caret, option.handle)
    setDraft(next.text)
    setCaret(next.caret)
    setActive(0)
    requestAnimationFrame(() => {
      box.current?.setSelectionRange(next.caret, next.caret)
    })
  }

  const send = async () => {
    const text = draft.trim()
    if (text === '' || sending) {
      return
    }
    setSending(true)
    try {
      const posted = await clientSend.run(text, async (clientId, retry) => {
        const body = { text, client_id: clientId } satisfies TeamPostInput
        return apiSend<TeamPosted>('/team/messages', body, retry)
      })
      setDraft('')
      setCaret(0)
      setStatus(outcomeText(posted))
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setSending(false)
    }
  }

  const onListKey = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    const picked = items[current]
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      setActive((current + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length)
    } else if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey && picked !== undefined) {
      pick(picked)
    } else if (e.key === 'Escape') {
      setDismissed(draft)
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
    const enterSends = !touch && !e.shiftKey && !e.altKey && !e.nativeEvent.isComposing
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || enterSends)) {
      e.preventDefault()
      void send()
    }
  }

  return (
    <div className="shrink-0 space-y-1 border-t border-border p-2">
      <MessageFindBar find={find} editable />
      <div className="flex gap-2">
        <div className="relative min-w-0 flex-1">
          <FindableTextarea
            ref={box}
            find={find}
            rows={2}
            value={draft}
            aria-label="Message the group"
            data-primary-input
            placeholder={touch ? 'Message the group' : 'Message the group; @ mentions an agent (Enter)'}
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={open ? `${listId}-${String(current)}` : undefined}
            className="max-h-[30dvh] overflow-y-auto"
            onChange={(e) => {
              setDraft(e.target.value)
              setCaret(e.target.selectionStart)
              setActive(0)
            }}
            onSelect={(e) => {
              setCaret(e.currentTarget.selectionStart)
            }}
            onKeyDown={onKeyDown}
          />
          {open && (
            <div
              id={listId}
              role="listbox"
              aria-label="Mention suggestions"
              className="absolute bottom-full left-0 z-20 mb-1 max-h-60 w-full overflow-y-auto border border-border bg-popover py-1 text-xs text-popover-foreground shadow-md"
            >
              {items.map((option, index) => (
                <div
                  key={option.handle}
                  id={`${listId}-${String(index)}`}
                  role="option"
                  tabIndex={-1}
                  aria-selected={index === current}
                  className={cn(
                    'flex cursor-pointer gap-2 px-2 py-1',
                    index === current && 'bg-accent text-accent-foreground',
                  )}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    pick(option)
                  }}
                >
                  <span className={cn('shrink-0 font-medium', option.quiet && 'text-muted-foreground')}>
                    @{option.handle}
                  </span>
                  <span className="min-w-0 truncate text-muted-foreground">{option.detail}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        {touch && <FindButton find={find} />}
        {touch && (
          <Button aria-label="Send to the group" disabled={sending || draft.trim() === ''} onClick={() => void send()}>
            <Send className="size-4" />
          </Button>
        )}
      </div>
      <p role="status" aria-label="Group chat status" className="min-h-4 truncate px-1 text-2xs text-muted-foreground">
        {(clientSend.retrying ? RETRYING_LABEL : status) ??
          (touch
            ? '@ mentions an agent and reaches it mid-turn'
            : '@agent reaches it mid-turn; @all reaches every active agent')}
      </p>
    </div>
  )
}
