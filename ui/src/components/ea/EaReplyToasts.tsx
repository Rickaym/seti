import { tierToasts, type EaAsk, type EaAskDecision, type EaRepliesSeenInput } from '@seti/shared'
import { Check, Maximize2, MessagesSquare, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { toast } from 'sonner'
import { errorText } from '@/api'
import { Markdown } from '@/components/Markdown'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { dismissBrief, useAttention } from '@/hooks/useAttention'
import { useNotifications } from '@/hooks/useNotifications'
import { navigate } from '@/lib/route'
import { BriefToast } from './BriefToast'
import { useEaCall } from './call-context'
import { callActive } from './call-state'
import { ASK_OUTCOMES, askLabel, nextSettle, replyToasts, type ReplyToast } from './reply-toasts'
import { answerAsk, focusEaMessage, markRepliesSeen, useEaChatShown, useEaReplies } from './useEaReplies'

function seen(input: EaRepliesSeenInput) {
  markRepliesSeen(input).catch((e: unknown) => {
    toast.error('Could not mark the EA message seen', { description: errorText(e), duration: Infinity })
  })
}

function AskRow({ ask, several }: { ask: EaAsk; several: boolean }) {
  const [busy, setBusy] = useState(false)
  const decide = async (decision: EaAskDecision) => {
    setBusy(true)
    try {
      await answerAsk(ask.id, decision)
    } catch (e) {
      toast.error('The answer did not reach the EA', { description: errorText(e), duration: Infinity })
    } finally {
      setBusy(false)
    }
  }
  const label = askLabel(ask.summary)
  const open = ask.state === 'pending'
  return (
    <div className="mt-2 space-y-1.5">
      {several && <p className="text-xs text-muted-foreground">{label}</p>}
      <div className="flex items-center gap-2" role="group" aria-label={label}>
        <Button
          size="sm"
          disabled={!open || busy}
          aria-label={`Allow: ${label}`}
          title={label}
          onClick={() => void decide('allow')}
        >
          <Check />
          Allow
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!open || busy}
          aria-label={`Deny: ${label}`}
          title={label}
          onClick={() => void decide('deny')}
        >
          <X />
          Deny
        </Button>
        {ask.state !== 'pending' && (
          <span className="text-xs text-muted-foreground" role="status">
            {ASK_OUTCOMES[ask.state]}
            {ask.state === 'failed' && ask.detail !== null && ask.detail !== '' ? `: ${ask.detail}` : ''}
          </span>
        )}
      </div>
    </div>
  )
}

function openChat(id: number | null, done: EaRepliesSeenInput) {
  if (id !== null) {
    focusEaMessage(id)
  }
  seen(done)
  navigate('ea')
}

/** A tap on the text opens the EA chat; links and buttons inside keep their own action. */
function opensChat(open: () => void) {
  return (event: MouseEvent) => {
    if (event.target instanceof Element && event.target.closest('a, button') !== null) {
      return
    }
    open()
  }
}

/** Whether the element's content runs past its height, rechecked as the text changes. */
function useOverflows(text: string) {
  const ref = useRef<HTMLDivElement>(null)
  const [overflows, setOverflows] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    setOverflows(el !== null && el.scrollHeight > el.clientHeight + 1)
  }, [text])
  return { ref, overflows }
}

/** The whole reply in a dialog, for one too long for its toast. */
function FullReply({ id, text, onClose }: { id: number; text: string; onClose: () => void }) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose()
        }
      }}
    >
      <DialogContent className="flex max-h-[85dvh] flex-col">
        <DialogHeader>
          <DialogTitle>EA</DialogTitle>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <Markdown text={text} />
        </div>
        <DialogFooter>
          <Button
            onClick={() => {
              onClose()
              openChat(id, { ids: [id] })
            }}
          >
            <MessagesSquare />
            Open chat
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** A reply's text and its questions, live from the shared poll so every tab shows the same state. */
function ReplyBody({ id, text }: { id: number; text: string }) {
  const { data } = useEaReplies()
  const asks = data?.replies.find((reply) => reply.id === id)?.asks ?? []
  const [full, setFull] = useState(false)
  const { ref, overflows } = useOverflows(text)
  return (
    <div className="font-normal">
      <div
        ref={ref}
        role="presentation"
        className="max-h-40 cursor-pointer overflow-hidden"
        onClick={opensChat(() => {
          openChat(id, { ids: [id] })
        })}
      >
        <Markdown text={text} className="space-y-1" />
      </div>
      {overflows && (
        <Button
          size="xs"
          variant="ghost"
          className="mt-1 -ml-2"
          onClick={() => {
            setFull(true)
          }}
        >
          <Maximize2 />
          More
        </Button>
      )}
      {full && (
        <FullReply
          id={id}
          text={text}
          onClose={() => {
            setFull(false)
          }}
        />
      )}
      {asks.map((ask) => (
        <AskRow key={ask.id} ask={ask} several={asks.length > 1} />
      ))}
    </div>
  )
}

function closeBrief(id: string) {
  dismissBrief(id).catch((e: unknown) => {
    toast.error('Could not dismiss the brief', { description: errorText(e), duration: Infinity })
  })
}

function show(item: ReplyToast, closing: Set<string>) {
  if (item.kind === 'brief') {
    const { brief, seen: folded } = item
    toast(<BriefToast brief={brief} replies={item.replies} beyond={item.beyond} />, {
      id: item.key,
      duration: Number.POSITIVE_INFINITY,
      onDismiss: () => {
        if (closing.delete(item.key)) {
          return
        }
        if (brief !== null) {
          closeBrief(brief.id)
        }
        if (folded !== null) {
          seen(folded)
        }
      },
    })
    return
  }
  const onDismiss = (input: EaRepliesSeenInput) => () => {
    if (!closing.delete(item.key)) {
      seen(input)
    }
  }
  const { reply } = item
  toast(<ReplyBody id={reply.id} text={reply.text} />, {
    id: item.key,
    duration: Number.POSITIVE_INFINITY,
    onDismiss: onDismiss({ ids: [reply.id] }),
  })
}

/** Ticks once the newest unseen reply has had time to be seen in an open EA chat elsewhere. */
function useSettledNow(wait: number | null): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (wait === null) {
      return undefined
    }
    const timer = window.setTimeout(() => {
      setNow(Date.now())
    }, wait + 50)
    return () => {
      window.clearTimeout(timer)
    }
  }, [wait])
  return now
}

/**
 * Toasts that stay until dismissed for EA messages the user has not seen and for the brief that
 * waits after an absence, while no EA call runs. Dismissing one marks it seen on every device.
 */
export function EaReplyToasts() {
  const { data, lastOk } = useEaReplies()
  const { brief } = useAttention()
  const { settings } = useNotifications()
  const calling = callActive(useEaCall().phase)
  const chatShown = useEaChatShown()
  const polledAt = lastOk ?? 0
  const now = Math.max(useSettledNow(nextSettle(data, polledAt)), polledAt)
  const toasts = tierToasts(settings, 'active')
  const items = useMemo(
    () => replyToasts({ page: data, brief, calling, chatShown, toasts, now }),
    [data, brief, calling, chatShown, toasts, now],
  )
  const shown = useRef(new Set<string>())
  const closing = useRef(new Set<string>())

  useEffect(() => {
    const wanted = new Map(items.map((item) => [item.key, item]))
    for (const key of shown.current) {
      if (!wanted.has(key)) {
        closing.current.add(key)
        toast.dismiss(key)
      }
    }
    for (const item of wanted.values()) {
      show(item, closing.current)
    }
    shown.current = new Set(wanted.keys())
  }, [items])

  return null
}
