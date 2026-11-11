import { SIDE_QUESTION_MAX, type Aside, type ModDockProps, type UiModApi } from '@seti/mod-api'
import { AlertCircle, ArrowUp, Check, FileText, Forward, LoaderCircle, MessageSquarePlus } from 'lucide-react'
import {
  Fragment,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { asideActions } from './aside-actions'
import { askerLabel } from './asker'
import type { AgentAsides, SideChats } from './chat-store'

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
  /** Changes each time the field should take focus. */
  focus: number
  onAsk: (question: string) => void
}

interface ExchangeProps {
  question: string
  answer: string
  reads: readonly string[]
  /** Who asked, when it was not the user. */
  label: string | null
  answering: boolean
  error: string | null
  actions?: ReactNode
}

/** Asides of different chats, with a divider where a new chat starts. */
const startsChat = (asides: readonly Aside[], index: number) =>
  index > 0 && asides[index - 1]?.chat_id !== asides[index]?.chat_id

/** The side chat's dock: questions to an agent's context, answered here and kept as asides. */
export function sideChatView(api: UiModApi, chats: SideChats): ComponentType<ModDockProps> {
  const { AgentText, Button, Hint, Line, Textarea, ToggleButton } = api.kit
  const { DeleteButton, ClearButton } = asideActions(api, chats)

  /** Sends a side chat's question and answer to the agent as a normal message, once. */
  function ForwardButton({ agent, aside }: { agent: string; aside: Aside }) {
    const [sent, setSent] = useState(false)
    const forward = async () => {
      setSent(true)
      try {
        await api.agents.send(agent, sideChatForward(aside.question, aside.answer))
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

  function Exchange({ question, answer, reads, label, answering, error, actions }: ExchangeProps) {
    return (
      <div className="space-y-2" data-testid="side-chat-exchange">
        {label !== null && <p className="ml-6 text-2xs text-muted-foreground">{label}</p>}
        <div className="ml-6 border border-primary/30 bg-primary/10 px-3 py-2 text-sm whitespace-pre-wrap">
          {question}
        </div>
        {reads.map((read, i) => (
          <Line key={`${String(i)}-${read}`} icon={FileText}>
            {read}
          </Line>
        ))}
        {answer !== '' && <AgentText text={answer} />}
        {answering && answer === '' && (
          <Line icon={LoaderCircle}>
            <span className="animate-pulse">Thinking</span>
          </Line>
        )}
        {error !== null && (
          <Line icon={AlertCircle} error>
            {error}
          </Line>
        )}
        {actions !== undefined && <div className="flex items-center gap-1">{actions}</div>}
      </div>
    )
  }

  /** The question field: Enter asks, Shift+Enter or Ctrl+Enter adds a line. */
  function AskField({ busy, focus, onAsk }: AskFieldProps) {
    const [text, setText] = useState('')
    const field = useRef<HTMLTextAreaElement>(null)
    useEffect(() => {
      field.current?.focus()
    }, [focus])
    const submit = () => {
      const question = text.trim()
      if (question !== '' && !busy) {
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
            disabled={busy || text.trim() === ''}
            className="pointer-coarse:size-11"
          >
            <ArrowUp />
          </Button>
        </div>
      </form>
    )
  }

  /** New chat and Clear, above the asides once there are any. */
  function Toolbar({ agent, chat }: { agent: ModDockProps['agent']; chat: AgentAsides }) {
    return (
      <div className="flex items-center justify-end gap-1 border-b border-border px-2 py-1">
        <ToggleButton
          pressed={chat.startNew}
          onPressedChange={(pressed) => {
            chats.setStartNew(agent.id, pressed)
          }}
          icon={<MessageSquarePlus />}
          label="New chat"
          hint="The next question starts a new side chat instead of following up the last one"
        />
        <ClearButton agent={agent.id} title={agent.title} count={chat.asides.length} />
      </div>
    )
  }

  function History({ agent, chat }: { agent: string; chat: AgentAsides }) {
    return chat.asides.map((aside, index) => (
      <Fragment key={aside.id}>
        {startsChat(chat.asides, index) && (
          <p className="text-center text-2xs tracking-wider text-muted-foreground uppercase">New chat</p>
        )}
        <Exchange
          question={aside.question}
          answer={aside.answer}
          reads={chat.reads.get(aside.id) ?? []}
          label={askerLabel(aside)}
          answering={false}
          error={null}
          actions={
            <>
              <ForwardButton agent={agent} aside={aside} />
              <DeleteButton agent={agent} id={aside.id} />
            </>
          }
        />
      </Fragment>
    ))
  }

  return function SideChat({ agent, focus }: ModDockProps) {
    const chat = useSyncExternalStore(chats.subscribe, () => chats.view(agent.id))
    const scroller = useRef<HTMLDivElement>(null)
    useEffect(() => chats.watch(agent.id), [agent.id])
    useEffect(() => {
      const el = scroller.current
      if (el !== null) {
        el.scrollTop = el.scrollHeight
      }
    }, [chat.asides, chat.pending])
    const { pending } = chat
    const empty = chat.asides.length === 0 && pending === null
    return (
      <>
        {chat.asides.length > 0 && <Toolbar agent={agent} chat={chat} />}
        <div ref={scroller} className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-3 py-3">
          {empty && (
            <p className="text-sm text-muted-foreground">
              Ask {agent.title} about its work. It answers from what it has seen, without stopping, and never sees this
              chat unless you send it an answer. Each answer stays in its transcript as an aside. Typing{' '}
              <code>{ASK_COMMAND}</code> and a question in the reply box asks here too.
            </p>
          )}
          <History agent={agent.id} chat={chat} />
          {chat.startNew && chat.asides.length > 0 && (
            <p className="text-center text-2xs tracking-wider text-muted-foreground uppercase">New chat</p>
          )}
          {pending !== null && (
            <Exchange
              question={pending.question}
              answer={pending.answer}
              reads={pending.reads}
              label={null}
              answering={pending.state === 'answering'}
              error={pending.error}
            />
          )}
        </div>
        <AskField
          busy={chat.answering}
          focus={focus}
          onAsk={(question) => {
            chats.ask(agent.id, question)
          }}
        />
      </>
    )
  }
}
