import { checkComposer, confirmationFor, type AttachmentRef, type ComposerCheck } from '@seti/shared'
import { ListPlus, Play, Send, SquareTerminal, Zap } from 'lucide-react'
import { memo, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { apiPost, errorText } from '@/api'
import { Hint } from '@/components/Hint'
import { MessageFindBar } from '@/components/find/FindBar'
import { FindButton } from '@/components/find/FindButton'
import { useFind } from '@/components/find/useFind'
import { Button } from '@/components/ui/button'
import { useConfirm } from '@/components/ui/confirm-context'
import { useAttachments, type Attachments } from '@/hooks/useAttachments'
import { useCapabilities } from '@/hooks/useCapabilities'
import { useCommandCatalog } from '@/hooks/useCommandCatalog'
import { useCoarsePointer } from '@/hooks/useMedia'
import { withTokens } from '@/lib/attachments'
import { taskDraftKey } from '@/lib/drafts'
import { keepFocus } from '@/lib/keep-focus'
import type { PendingSend, PendingStore } from '@/lib/pending-sends'
import { ModOffNotice } from '@/mods/ModOffNotice'
import { runModCommand } from '@/mods/commands'
import { useModSlash, type ModSlash, type ModSlashUi } from '@/mods/slash'
import { AttachButton, DraftAttachments } from '@/panels/tasks/AttachmentChips'
import { CommandField, ComposerStatus } from '@/panels/tasks/CommandField'
import { SettingCommandCard } from '@/panels/tasks/commands/SettingCommandCard'
import type { CommandHost } from '@/panels/tasks/commands/types'
import { useSettingCommand, type SettingCommand } from '@/panels/tasks/commands/useSettingCommand'
import { HINTS, hintKey, ROOMY_PX, useWiderThan } from '@/panels/tasks/composer-hints'

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

/**
 * Why the draft cannot go out: a setting command runs even while the agent works, and a mod's
 * slash command may wait while its mod is off or busy.
 */
function draftRefusal(
  setting: boolean,
  modSlash: ModSlash | null,
  waiting: string | null,
  ...rest: Parameters<typeof refusal>
): string | null {
  if (setting) {
    return rest[1].items.length > 0 ? COMMAND_FILES : null
  }
  if (modSlash?.kind === 'off') {
    return `${modSlash.mod.name} is off`
  }
  if (modSlash?.kind === 'lacks') {
    return modSlash.reason
  }
  if (modSlash !== null) {
    return rest[1].items.length > 0 ? COMMAND_FILES : waiting
  }
  return refusal(...rest)
}

/** The choices for the word of a Seti command being typed, and how one is picked. */
const wordChoices = (setting: SettingCommand | null) => ({
  completion: setting?.completion ?? null,
  onPickWord: setting?.pick,
})

/** What the send button does with the draft. */
type SendMode = 'shell' | 'action' | 'queue' | 'send'

function sendMode(check: ComposerCheck, agentRunning: boolean, command: boolean, modSlash: ModSlash | null): SendMode {
  if (command || modSlash !== null) {
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
  onClick: (trusted: boolean) => void
  disabled: boolean
}

/** The send button of a phone: what it does, a mod's command by its title and icon. */
function SendButton({ mode, slash, ui, onClick, disabled }: SendButtonProps) {
  const command = slash?.kind === 'run' ? slash.command.title : null
  const Icon = (mode === 'action' ? ui.icon : null) ?? SEND_ICON[mode]
  return (
    <Button
      aria-label={command ?? SEND_LABEL[mode]}
      className="min-h-11 min-w-11"
      onMouseDown={keepFocus}
      disabled={disabled}
      onClick={(e) => {
        onClick(e.nativeEvent.isTrusted)
      }}
    >
      <Icon className="size-4" />
    </Button>
  )
}

/**
 * The reply box of a task: messages and slash commands go to the agent and `!` commands run here.
 * Seti's setting commands and a mod's slash command, such as the side chat's, run in Seti and
 * never reach the agent.
 */
export const Composer = memo(function ComposerView({
  host,
  agentRunning,
  compacting,
  shellRunning,
  draft,
  onDraftChange: setDraft,
  sends,
}: {
  /** The agent, and what its view lends the setting commands. */
  host: CommandHost
  agentRunning: boolean
  compacting: boolean
  shellRunning: boolean
  /** Kept by the task view, which fills it with the prompt of a rewind. */
  draft: string
  onDraftChange: (draft: string) => void
  /** Sends messages one at a time and shows them in the transcript until their rows arrive. */
  sends: PendingStore
}) {
  const { id: taskId, cwd } = host.task
  const rewind = useCapabilities(host.task)?.rewind !== false
  const confirm = useConfirm()
  const touch = useCoarsePointer()
  const box = useRef<HTMLDivElement>(null)
  const roomy = useWiderThan(box, ROOMY_PX)
  const find = useFind()
  const [sending, setSending] = useState(false)
  const latestDraft = useRef(draft)
  useLayoutEffect(() => {
    latestDraft.current = draft
  })
  const attachments = useAttachments(taskDraftKey(taskId), draft, setDraft)
  const commands = useCommandCatalog(`/tasks/${taskId}/commands`, draft.trimStart().startsWith('/'))
  const check = checkComposer(draft, commands.commands)
  const { slash: modSlash, ui: slashUi } = useModSlash(draft, taskId)
  const [typedText, setTypedText] = useState<string | null>(null)
  const [setting, settingDialog] = useSettingCommand(host, draft, typedText, (text, byUser) => {
    setDraft(text)
    setTypedText(byUser ? text : null)
  })
  const files = attachments.items.length
  const shell = check.kind === 'shell'
  const mode = sendMode(check, agentRunning, setting !== null, modSlash)
  const refused = draftRefusal(setting !== null, modSlash, slashUi.waiting, check, attachments, agentRunning, touch)
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

  const send = async (interrupt: boolean, trusted = true) => {
    if (blocked || setting?.submit(trusted) === true) {
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
      <SettingCommandCard command={setting} dialog={settingDialog} />
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
      <MessageFindBar find={find} editable={!shellRunning} />
      <div className="flex items-end gap-2">
        <CommandField
          value={draft}
          onChange={setDraft}
          onTyped={setTypedText}
          onEscape={() => setting?.dismiss() === true}
          {...wordChoices(setting)}
          commands={commands}
          label="Reply"
          placeholder={HINTS[hintKey({ agentRunning, compacting, shellRunning, rewind }, touch)][roomy ? 0 : 1]}
          rows={2}
          className="max-md:min-h-11 pointer-coarse:placeholder:text-sm"
          disabled={shellRunning}
          placement="above"
          primary
          onSubmit={(trusted) => void send(false, trusted)}
          enterSends={!touch}
          onAltSubmit={agentRunning ? (trusted) => void send(true, trusted) : undefined}
          attach={{ text: attachments.addText, files: attachments.addFiles }}
          find={find}
        />
        {touch && <FindButton find={find} />}
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
              onMouseDown={keepFocus}
              onClick={() => void send(true)}
              disabled={blocked || mode === 'action'}
            >
              <Zap />
              <span className="@max-[37.5rem]/composer:hidden">Interrupt</span>
            </Button>
          </Hint>
        )}
        {touch && (
          <SendButton
            mode={mode}
            slash={modSlash}
            ui={slashUi}
            onClick={(trusted) => void send(false, trusted)}
            disabled={blocked}
          />
        )}
      </div>
    </div>
  )
})
