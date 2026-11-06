import { SIDE_CHAT_TURNS, SIDE_QUESTION_MAX, type ModDockProps, type UiModApi } from '@seti/mod-api'
import { AlertCircle, ArrowUp, Check, FileText, Forward, LoaderCircle } from 'lucide-react'
import { useEffect, useRef, useState, useSyncExternalStore, type ComponentType, type KeyboardEvent } from 'react'
import type { SideChats, SideExchange } from './chat-store'

/** How the reply box and the dock name the side chat's command. */
const ASK_COMMAND = '/btw'

/** Why a question waits: one answer at a time, so it stays where it was typed. */
export const SIDE_BUSY = 'The side chat is still answering. Ask again when it finishes.'

/** The message "Send to agent" sends: the side chat's question and the answer it got. */
const sideChatForward = (asked: string, answer: string): string =>
  ['From a side chat about your work.', '', `Question: ${asked.trim()}`, '', 'Answer:', answer.trim()].join('\n')

interface AskFieldProps {
  /** An answer is streaming, so a question stays in the field with the reason. */
  busy: boolean
  disabled: boolean
  /** Changes each time the field should take focus. */
  focus: number
  onAsk: (question: string) => void
}

/** The side chat's dock: questions to an agent's context, answered here and discarded on close. */
export function sideChatView(api: UiModApi, chats: SideChats): ComponentType<ModDockProps> {
  const { AgentText, Button, Hint, Line, Textarea } = api.kit

  /** Sends a side chat's question and answer to the agent as a normal message, once. */
  function ForwardButton({ agent, exchange }: { agent: string; exchange: SideExchange }) {
    const [sent, setSent] = useState(false)
    const forward = async () => {
      setSent(true)
      try {
        await api.agents.send(agent, sideChatForward(exchange.question, exchange.answer))
        api.kit.succeed('Sent to the agent')
      } catch (e) {
        setSent(false)
        api.kit.fail(api.kit.errorText(e))
      }
    }
    return (
      <Hint text="Send this question and answer to the agent as a normal message">
        <Button variant="ghost" size="xs" disabled={sent} onClick={() => void forward()}>
          {sent ? <Check /> : <Forward />}
          {sent ? 'Sent' : 'Send to agent'}
        </Button>
      </Hint>
    )
  }

  function Exchange({ agent, exchange }: { agent: string; exchange: SideExchange }) {
    return (
      <div className="space-y-2" data-testid="side-chat-exchange">
        <div className="ml-6 border border-primary/30 bg-primary/10 px-3 py-2 text-sm whitespace-pre-wrap">
          {exchange.question}
        </div>
        {exchange.reads.map((read, i) => (
          <Line key={`${String(i)}-${read}`} icon={FileText}>
            {read}
          </Line>
        ))}
        {exchange.answer !== '' && <AgentText text={exchange.answer} />}
        {exchange.state === 'answering' && exchange.answer === '' && (
          <Line icon={LoaderCircle}>
            <span className="animate-pulse">Thinking</span>
          </Line>
        )}
        {exchange.error !== null && (
          <Line icon={AlertCircle} error>
            {exchange.error}
          </Line>
        )}
        {exchange.state === 'done' && <ForwardButton agent={agent} exchange={exchange} />}
      </div>
    )
  }

  /** The question field: Enter asks, Shift+Enter or Ctrl+Enter adds a line. */
  function AskField({ busy, disabled, focus, onAsk }: AskFieldProps) {
    const [text, setText] = useState('')
    const field = useRef<HTMLTextAreaElement>(null)
    useEffect(() => {
      const el = field.current
      if (el?.disabled === true) {
        el.closest<HTMLElement>('[role="dialog"]')?.focus()
      } else {
        el?.focus()
      }
    }, [focus])
    const submit = () => {
      const question = text.trim()
      if (question !== '' && !busy && !disabled) {
        onAsk(question)
        setText('')
      }
    }
    const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.nativeEvent.isComposing) {
        e.preventDefault()
        submit()
      }
    }
    return (
      <form
        className="border-t border-border p-2"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        {busy && text.trim() !== '' && (
          <p role="status" aria-label="Side chat status" className="px-1 pb-1.5 text-2xs text-muted-foreground">
            {SIDE_BUSY}
          </p>
        )}
        <div className="flex items-end gap-1.5">
          <Textarea
            ref={field}
            aria-label="Side question"
            placeholder="Ask about its work"
            enterKeyHint="send"
            rows={1}
            maxLength={SIDE_QUESTION_MAX}
            value={text}
            onChange={(e) => {
              setText(e.target.value)
            }}
            onKeyDown={onKeyDown}
            className="max-h-32 min-h-9 resize-none text-base md:text-sm"
          />
          <Button
            type="submit"
            size="icon-sm"
            aria-label="Ask"
            disabled={busy || disabled || text.trim() === ''}
            className="pointer-coarse:size-11"
          >
            <ArrowUp />
          </Button>
        </div>
      </form>
    )
  }

  return function SideChat({ agent, focus }: ModDockProps) {
    const chat = useSyncExternalStore(chats.subscribe, () => chats.view(agent.id))
    const scroller = useRef<HTMLDivElement>(null)
    useEffect(() => {
      const el = scroller.current
      if (el !== null) {
        el.scrollTop = el.scrollHeight
      }
    }, [chat.exchanges])
    const used = chat.turnsLeft === 0 && !chat.answering
    return (
      <>
        <div ref={scroller} className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-3 py-3">
          {chat.exchanges.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Ask {agent.title} about its work. It answers from what it has seen, without stopping, and never sees this
              chat unless you send it an answer. Typing <code>{ASK_COMMAND}</code> and a question in the reply box asks
              here too.
            </p>
          )}
          {chat.exchanges.map((exchange) => (
            <Exchange key={exchange.id} agent={agent.id} exchange={exchange} />
          ))}
          {used && (
            <p className="text-xs text-muted-foreground">
              This side chat took its {SIDE_CHAT_TURNS} questions. Close it to start a new one.
            </p>
          )}
        </div>
        <AskField
          busy={chat.answering}
          disabled={used}
          focus={focus}
          onAsk={(question) => {
            chats.ask(agent.id, question)
          }}
        />
      </>
    )
  }
}
