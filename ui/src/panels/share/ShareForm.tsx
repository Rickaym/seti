import { checkComposer, confirmationFor, formatBytes, pasteGoesToFile } from '@seti/shared'
import { Send, TriangleAlert, X } from 'lucide-react'
import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { MessageFindBar } from '@/components/find/FindBar'
import { FindButton } from '@/components/find/FindButton'
import { useFind } from '@/components/find/useFind'
import { Button } from '@/components/ui/button'
import { useConfirm } from '@/components/ui/confirm-context'
import { useAttachments, type Attachments } from '@/hooks/useAttachments'
import { useCommandCatalog } from '@/hooks/useCommandCatalog'
import { useDraft } from '@/hooks/useDraft'
import { useCoarsePointer } from '@/hooks/useMedia'
import { sendShared } from '@/hooks/usePendingSends'
import { useTasks } from '@/hooks/useTasks'
import { withTokens } from '@/lib/attachments'
import { navigate } from '@/lib/route'
import { shareInbox, type LeftFile, type Share } from '@/lib/share-inbox'
import { openStartPage } from '@/lib/start-context'
import { AgentPicker } from '@/panels/share/AgentPicker'
import { carryToStart, sharedText } from '@/panels/share/share-draft'
import { AttachButton, DraftAttachments } from '@/panels/tasks/AttachmentChips'
import { CommandField, ComposerStatus } from '@/panels/tasks/CommandField'

const SHELL_IN_SHARE =
  "Shell commands only run from the agent's own reply box, so the agent gets this as a message. Send anyway?"

function LeftBehind({ files }: { files: readonly LeftFile[] }) {
  if (files.length === 0) {
    return null
  }
  return (
    <ul aria-label="Left out" className="space-y-0.5 px-1 text-2xs text-muted-foreground">
      {files.map((file, n) => (
        <li key={`${file.name}-${String(n)}`} className="flex items-center gap-1.5">
          <TriangleAlert className="size-3 shrink-0" aria-hidden />
          <span className="min-w-0 truncate">
            {file.name} ({formatBytes(file.size)}) stays out: {file.reason}
          </span>
        </li>
      ))}
    </ul>
  )
}

/** Uploads the shared files once; a chip's remove also takes its file out of the inbox. */
function useSharedFiles(share: Share, attachments: Attachments): Attachments {
  const sources = useRef(new Map<string, number>())
  const taken = useRef(false)
  const take = useEffectEvent(() => {
    const tokens = attachments.addFiles(share.files.map(({ file }) => file))
    tokens.forEach((token, n) => {
      const info = share.files[n]?.info
      if (info !== undefined) {
        sources.current.set(token, info.index)
      }
    })
    const text = sharedText(share.manifest)
    if (pasteGoesToFile(text)) {
      attachments.addText(text)
    }
  })
  useEffect(() => {
    if (!taken.current) {
      taken.current = true
      take()
    }
  }, [])
  const drop = (key: string) => {
    const item = attachments.items.find((other) => other.key === key)
    const index = item === undefined ? undefined : sources.current.get(item.token)
    if (index !== undefined) {
      void shareInbox.drop(index)
    }
    attachments.drop(key)
  }
  return { ...attachments, drop }
}

/** Why Send waits, or what it does, for the line under the box. */
function sendNote(picked: string | null, title: string | undefined, pending: string | null): string {
  if (pending !== null) {
    return pending
  }
  return picked === null ? 'Pick an agent, or start a new one.' : `Goes to ${title ?? 'the agent'}.`
}

/** The share: its files as chips, its text in the box, and the agent it goes to. */
export function ShareForm({ share }: { share: Share }) {
  const touch = useCoarsePointer()
  const confirm = useConfirm()
  const { tasks } = useTasks()
  const text = sharedText(share.manifest)
  const [prompt, setPrompt] = useDraft(`share.${share.manifest.id}`, pasteGoesToFile(text) ? '' : text)
  const attachments = useAttachments(null, prompt, setPrompt)
  const chips = useSharedFiles(share, attachments)
  const find = useFind()
  const [picked, setPicked] = useState<string | null>(null)
  const commands = useCommandCatalog(
    picked === null ? '/commands' : `/tasks/${picked}/commands`,
    prompt.trimStart().startsWith('/'),
  )
  const check = checkComposer(prompt, commands.commands)
  const files = attachments.items.length
  const filled = prompt.trim() !== '' || files > 0
  const ready = picked !== null && filled && attachments.pending === null

  const finish = (then: () => void) => {
    setPrompt('')
    void shareInbox.clear().finally(then)
  }

  const send = async () => {
    if (!ready) {
      return
    }
    const question = check.kind === 'shell' ? SHELL_IN_SHARE : confirmationFor(check)
    if (
      question !== null &&
      !(await confirm({ title: 'Check the message', message: question, confirmLabel: 'Send anyway' }))
    ) {
      return
    }
    const message = attachments.message(prompt)
    sendShared(picked, {
      text: prompt,
      prompt: message.prompt,
      attachments: message.attachments ?? [],
      files: attachments.items,
    })
    attachments.sent()
    finish(() => {
      navigate('agents', picked, { force: true })
    })
  }

  const cancel = () => {
    for (const item of attachments.items) {
      attachments.drop(item.key)
    }
    finish(() => {
      navigate('home')
    })
  }

  const newAgent = () => {
    carryToStart({ text: prompt, items: attachments.items })
    attachments.sent()
    finish(openStartPage)
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-2 max-md:px-2">
        <h1 className="text-base font-semibold">Share</h1>
        <Button variant="ghost" size="sm" className="pointer-coarse:min-h-11" onClick={cancel}>
          <X />
          Cancel
        </Button>
      </div>
      <div className="mx-auto flex min-h-0 w-full max-w-2xl flex-1 flex-col gap-3 overflow-y-auto p-4 max-md:p-2">
        <div className="relative shrink-0 border border-border bg-card focus-within:border-ring">
          {files > 0 && (
            <div className="px-2 pt-2">
              <DraftAttachments attachments={chips} />
            </div>
          )}
          <MessageFindBar find={find} editable />
          <CommandField
            value={prompt}
            onChange={setPrompt}
            commands={commands}
            label="Message"
            placeholder="What should the agent do with this?"
            rows={3}
            placement="below"
            onSubmit={() => void send()}
            enterSends={false}
            attach={{ text: attachments.addText, files: attachments.addFiles }}
            find={find}
            className="min-h-20 border-0 px-3 py-3 text-sm focus-visible:ring-0 md:text-sm dark:bg-transparent"
          />
          <div className="flex justify-end gap-1 px-2 pb-2">
            {touch && <FindButton find={find} />}
            <AttachButton
              onFiles={(chosen) => {
                setPrompt(withTokens(prompt, attachments.addFiles(chosen)))
              }}
            />
          </div>
        </div>
        <LeftBehind files={share.manifest.left} />
        <AgentPicker
          tasks={tasks}
          picked={picked}
          onPick={setPicked}
          onNewAgent={newAgent}
          newAgentBlocked={attachments.pending}
        />
      </div>
      <div className="shrink-0 border-t border-border bg-card px-4 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] max-md:px-2">
        <div className="mx-auto flex w-full max-w-2xl items-center gap-3">
          <ComposerStatus
            check={check}
            commands={commands}
            shellCwd={null}
            idle={sendNote(picked, tasks.find((task) => task.id === picked)?.title, attachments.pending)}
          />
          <Button className="ml-auto shrink-0 pointer-coarse:min-h-11" disabled={!ready} onClick={() => void send()}>
            <Send />
            Send
          </Button>
        </div>
      </div>
    </div>
  )
}
