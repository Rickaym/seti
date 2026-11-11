import type { ModTranscriptBlockProps, UiModApi } from '@seti/mod-api'
import { ChevronDown, ChevronRight, LoaderCircle, MessageCircleQuestionMark } from 'lucide-react'
import { useState, useSyncExternalStore, type ComponentType, type ReactNode } from 'react'
import { asideActions } from './aside-actions'
import { askedTime, askerLabel } from './asker'
import { PENDING, type SideChats } from './chat-store'

interface FrameProps {
  open: boolean
  onToggle: () => void
  question: string
  label: string | null
  at: string
  actions?: ReactNode
  children: ReactNode
}

/**
 * An aside in the agent's transcript: a muted block with the side chat's icon that folds to one
 * line, so it never reads as one of the agent's own turns.
 */
export function asideBlockView(api: UiModApi, chats: SideChats): ComponentType<ModTranscriptBlockProps> {
  const { AgentText, Line } = api.kit
  const { DeleteButton } = asideActions(api, chats)
  const Chevron = ({ open }: { open: boolean }) =>
    open ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />

  function Frame({ open, onToggle, question, label, at, actions, children }: FrameProps) {
    return (
      <div
        role="group"
        aria-label="Aside"
        data-testid="aside"
        className="rounded-md border border-dashed border-border bg-muted/40 px-3 py-2 text-sm"
      >
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <button
            type="button"
            aria-expanded={open}
            onClick={onToggle}
            className="flex min-h-7 min-w-0 flex-1 items-center gap-1.5 text-left pointer-coarse:min-h-11"
          >
            <Chevron open={open} />
            <MessageCircleQuestionMark className="size-3.5 shrink-0" />
            <span className="font-medium tracking-wider uppercase">Aside</span>
            {label !== null && <span className="shrink-0">{label}</span>}
            {!open && <span className="min-w-0 truncate">{question}</span>}
          </button>
          <time dateTime={at} className="shrink-0 tabular-nums">
            {askedTime(at)}
          </time>
          {actions}
        </div>
        {open && (
          <div className="mt-2 space-y-2">
            <p className="text-muted-foreground whitespace-pre-wrap">{question}</p>
            {children}
          </div>
        )}
      </div>
    )
  }

  function Pending({ agent }: { agent: string }) {
    const pending = useSyncExternalStore(chats.subscribe, () => chats.view(agent).pending)
    const [open, setOpen] = useState(true)
    if (pending === null) {
      return null
    }
    return (
      <Frame
        open={open}
        onToggle={() => {
          setOpen(!open)
        }}
        question={pending.question}
        label={null}
        at={pending.asked_at}
      >
        {pending.answer === '' ? (
          <Line icon={LoaderCircle}>
            <span className="animate-pulse">Thinking</span>
          </Line>
        ) : (
          <AgentText text={pending.answer} />
        )}
      </Frame>
    )
  }

  return function AsideBlock({ agent, id }: ModTranscriptBlockProps) {
    const state = useSyncExternalStore(chats.subscribe, () => chats.view(agent))
    if (id === PENDING) {
      return <Pending agent={agent} />
    }
    const aside = state.asides.find((entry) => entry.id === id)
    if (aside === undefined) {
      return null
    }
    return (
      <Frame
        open={state.open.has(id)}
        onToggle={() => {
          chats.toggle(agent, id)
        }}
        question={aside.question}
        label={askerLabel(aside)}
        at={aside.asked_at}
        actions={<DeleteButton agent={agent} id={id} />}
      >
        <AgentText text={aside.answer} />
      </Frame>
    )
  }
}
