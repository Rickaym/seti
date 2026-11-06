import { checkComposer, confirmationFor, type AttachmentRef, type ComposerCheck } from '@seti/shared'
import { ListPlus, Play, Send, SquareTerminal, Zap } from 'lucide-react'
import { memo, useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { toast } from 'sonner'
import { apiPost, errorText } from '@/api'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { useConfirm } from '@/components/ui/confirm-context'
import { useAttachments, type Attachments } from '@/hooks/useAttachments'
import { useCommandCatalog } from '@/hooks/useCommandCatalog'
import { useCoarsePointer } from '@/hooks/useMedia'
import { withTokens } from '@/lib/attachments'
import { taskDraftKey } from '@/lib/drafts'
import type { PendingSend, PendingStore } from '@/lib/pending-sends'
import { ModOffNotice } from '@/mods/ModOffNotice'
import { runModCommand } from '@/mods/commands'
import { useModSlash, type ModSlash, type ModSlashUi } from '@/mods/slash'
import { AttachButton, DraftAttachments } from '@/panels/tasks/AttachmentChips'
import { CommandField, ComposerStatus } from '@/panels/tasks/CommandField'

/** Placeholder hints by state, as [roomy, compact]; a phone's compact one fits one line. */
const HINTS = {
  idle: [
    'Enter sends, Ctrl+Enter adds a line, Esc Esc rewinds. Start with / for a command or ! to run a shell command here.',
    'Enter sends, Ctrl+Enter adds a line. / commands, ! shell',
  ],
  touchIdle: ['Start with / for a command or ! to run a shell command here.', '/ command, ! shell'],
  busy: [
    'Enter queues it for the agent, Alt+Enter interrupts and sends. Esc stops it.',
    'Enter queues, Alt+Enter interrupts, Esc stops.',
  ],
  touchBusy: ['Send queues it for the agent; Interrupt stops the turn and sends.', 'Send queues it'],
  compacting: [
    'Compacting the conversation. Messages you send now queue until it finishes. Esc stops it.',
    'Compacting. Enter queues, Esc stops.',
  ],
  touchCompacting: [
    'Compacting the conversation. Messages you send now queue until it finishes. Stop ends it.',
    'Compacting; Send queues',
  ],
  shell: ['Esc stops the shell command.', 'Esc stops the shell command.'],
  touchShell: ['Stop ends the shell command.', 'Stop ends it'],
} as const satisfies Record<string, readonly [string, string]>

/** Below this composer width the roomy hints wrap past two lines, so the compact ones show. */
const ROOMY_PX = 600

const CONFIRM_TITLES: Partial<Record<ComposerCheck['kind'], string>> = {
  unknown: 'Unknown command',
  partial: 'Unknown command',
  unsupported: 'Command not supported',
  shell: 'Check the shell command',
}

const canSend = (draft: string, check: ComposerCheck, files: number) =>
  (draft.trim() !== '' || files > 0) && (check.kind !== 'shell' || check.command !== '')

/** What stays in the box once a shell command went out: the text typed after it meanwhile. */
const afterSend = (now: string, sent: string) => (now.startsWith(sent) ? now.slice(sent.length).trimStart() : now)

const withRefs = ({ prompt, attachments = [] }: { prompt: string; attachments?: AttachmentRef[] }) => ({
  prompt,
  attachments,
})

const COMMAND_FILES = 'Attachments go with messages, not with commands. Drop them to run this.'

/** Why the draft cannot go out: files with a command, or a command while the agent works. */
function refusal(check: ComposerCheck, attachments: Attachments, agentRunning: boolean, touch: boolean): string | null {
  if (check.kind === 'text') {
    return null
  }
  if (attachments.items.length > 0) {
    return COMMAND_FILES
  }
  return agentRunning ? busyRefusal(check, touch) : null
}

/** Why the draft cannot go out while the agent works; plain messages queue for it instead. */
function busyRefusal(check: Exclude<ComposerCheck, { kind: 'text' }>, touch: boolean): string {
  const what = check.kind === 'shell' ? 'Shell commands' : 'Slash commands'
  return `${what} wait until the agent finishes its turn. ${touch ? 'Stop ends it.' : 'Esc stops it.'}`
}

/** Why the draft cannot go out, a mod's slash command first: its mod may be off or busy. */
function draftRefusal(
  modSlash: ModSlash | null,
  waiting: string | null,
  ...rest: Parameters<typeof refusal>
): string | null {
  if (modSlash?.kind === 'off') {
    return `${modSlash.mod.name} is off`
  }
  if (modSlash !== null) {
    return rest[1].items.length > 0 ? COMMAND_FILES : waiting
  }
  return refusal(...rest)
}

interface ComposerState {
  agentRunning: boolean
  compacting: boolean
  shellRunning: boolean
}

/** Touch screens get the same hints without keyboard shortcuts. */
function hintKey({ agentRunning, compacting, shellRunning }: ComposerState, touch: boolean): keyof typeof HINTS {
  if (compacting) {
    return touch ? 'touchCompacting' : 'compacting'
  }
  if (agentRunning) {
    return touch ? 'touchBusy' : 'busy'
  }
  if (shellRunning) {
    return touch ? 'touchShell' : 'shell'
  }
  return touch ? 'touchIdle' : 'idle'
}

/** True while the element is at least `px` wide; re-renders only when that flips. */
function useWiderThan(element: RefObject<HTMLElement | null>, px: number): boolean {
  const [wider, setWider] = useState(false)
  useLayoutEffect(() => {
    const target = element.current
    if (target === null) {
      return undefined
    }
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined) {
        setWider(entry.contentRect.width >= px)
      }
    })
    observer.observe(target)
    return () => {
      observer.disconnect()
    }
  }, [element, px])
  return wider
}

/** What the send button does with the draft. */
type SendMode = 'shell' | 'action' | 'queue' | 'send'

function sendMode(check: ComposerCheck, agentRunning: boolean, modSlash: ModSlash | null): SendMode {
  if (modSlash !== null) {
    return 'action'
  }
  if (check.kind === 'shell') {
    return 'shell'
  }
  return agentRunning ? 'queue' : 'send'
}

const SEND_LABEL: Record<SendMode, string> = {
  shell: 'Run shell command',
  action: 'Run command',
  queue: 'Queue message',
  send: 'Send',
}

const SEND_ICON = { shell: SquareTerminal, action: Play, queue: ListPlus, send: Send } as const

interface SendButtonProps {
  mode: SendMode
  slash: ModSlash | null
  ui: ModSlashUi
  onClick: () => void
  disabled: boolean
}

/** The send button of a phone: what it does, a mod's command by its title and icon. */
function SendButton({ mode, slash, ui, ...button }: SendButtonProps) {
  const command = slash?.kind === 'run' ? slash.command.title : null
  const Icon = (mode === 'action' ? ui.icon : null) ?? SEND_ICON[mode]
  return (
    <Button aria-label={command ?? SEND_LABEL[mode]} className="min-h-11 min-w-11" {...button}>
      <Icon className="size-4" />
    </Button>
  )
}

/**
 * The reply box of a task: messages and slash commands go to the agent, `!` commands run here and
 * a mod's slash command, such as the side chat's, runs in Seti and never reaches the agent.
 */
export const Composer = memo(function ComposerView({
  taskId,
  cwd,
  agentRunning,
  compacting,
  shellRunning,
  draft,
  onDraftChange: setDraft,
  sends,
}: {
  taskId: string
  cwd: string
  agentRunning: boolean
  compacting: boolean
  shellRunning: boolean
  /** Kept by the task view, which fills it with the prompt of a rewind. */
  draft: string
  onDraftChange: (draft: string) => void
  /** Sends messages one at a time and shows them in the transcript until their rows arrive. */
  sends: PendingStore
}) {
  const confirm = useConfirm()
  const touch = useCoarsePointer()
  const box = useRef<HTMLDivElement>(null)
  const roomy = useWiderThan(box, ROOMY_PX)
  const [sending, setSending] = useState(false)
  const latestDraft = useRef(draft)
  useLayoutEffect(() => {
    latestDraft.current = draft
  })
  const attachments = useAttachments(taskDraftKey(taskId), draft, setDraft)
  const commands = useCommandCatalog(`/tasks/${taskId}/commands`, draft.trimStart().startsWith('/'))
  const check = checkComposer(draft, commands.commands)
  const { slash: modSlash, ui: slashUi } = useModSlash(draft, taskId)
  const shell = check.kind === 'shell'
  const mode = sendMode(check, agentRunning, modSlash)
  const refused = draftRefusal(modSlash, slashUi.waiting, check, attachments, agentRunning, touch)
  const files = attachments.items.length
  const blocked =
    shellRunning || sending || refused !== null || attachments.pending !== null || !canSend(draft, check, files)

  const takeBack = useEffectEvent((send: PendingSend) => {
    const typed = latestDraft.current
    setDraft(typed.trim() === '' ? send.text : `${send.text}\n${typed}`)
    attachments.restore(send.files)
  })
  useEffect(
    () =>
      sends.onEdit((send) => {
        takeBack(send)
      }),
    [sends],
  )

  const send = async (interrupt: boolean) => {
    if (blocked) {
      return
    }
    if (modSlash?.kind === 'run') {
      setDraft('')
      void runModCommand(modSlash.mod, modSlash.command, modSlash.args, { agent: taskId })
      return
    }
    const question = confirmationFor(check)
    const label = shell ? 'Run anyway' : 'Send anyway'
    const title = CONFIRM_TITLES[check.kind] ?? 'Confirm'
    if (question !== null && !(await confirm({ title, message: question, confirmLabel: label }))) {
      return
    }
    if (check.kind !== 'shell') {
      sends.add({
        text: draft,
        ...withRefs(attachments.message(draft)),
        files: attachments.items,
        interrupt: agentRunning && interrupt,
      })
      attachments.sent()
      setDraft('')
      return
    }
    setSending(true)
    const sent = draft
    try {
      await apiPost(`/tasks/${taskId}/shell`, { command: check.command })
      setDraft(afterSend(latestDraft.current, sent))
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setSending(false)
    }
  }

  return (
    <div
      ref={box}
      className="agent-focus @container/composer shrink-0 space-y-1 border-t border-border p-3 max-md:px-2 max-md:py-1 in-data-agent-frame:p-2"
    >
      <DraftAttachments attachments={attachments} />
      {modSlash?.kind === 'off' ? (
        <ModOffNotice mod={modSlash.mod} />
      ) : (
        <ComposerStatus
          check={check}
          commands={commands}
          shellCwd={cwd}
          idle={attachments.pending}
          refused={refused}
          action={slashUi.status}
        />
      )}
      <div className="flex items-end gap-2">
        <CommandField
          value={draft}
          onChange={setDraft}
          commands={commands}
          label="Reply"
          placeholder={HINTS[hintKey({ agentRunning, compacting, shellRunning }, touch)][roomy ? 0 : 1]}
          rows={2}
          className="max-md:min-h-11 pointer-coarse:placeholder:text-sm"
          disabled={shellRunning}
          placement="above"
          primary
          onSubmit={() => void send(false)}
          enterSends={!touch}
          onAltSubmit={agentRunning ? () => void send(true) : undefined}
          attach={{ text: attachments.addText, files: attachments.addFiles }}
        />
        <AttachButton
          disabled={shellRunning}
          onFiles={(picked) => {
            setDraft(withTokens(draft, attachments.addFiles(picked)))
          }}
        />
        {agentRunning && (
          <Hint text="Stop the agent's turn and send this instead (Alt+Enter)" side="top">
            <Button
              size="sm"
              variant="outline"
              aria-label="Interrupt and send"
              className="@max-[37.5rem]/composer:w-7 @max-[37.5rem]/composer:px-0 pointer-coarse:min-h-11 pointer-coarse:min-w-11"
              onClick={() => void send(true)}
              disabled={blocked || mode === 'action'}
            >
              <Zap />
              <span className="@max-[37.5rem]/composer:hidden">Interrupt</span>
            </Button>
          </Hint>
        )}
        {touch && (
          <SendButton mode={mode} slash={modSlash} ui={slashUi} onClick={() => void send(false)} disabled={blocked} />
        )}
      </div>
    </div>
  )
})
