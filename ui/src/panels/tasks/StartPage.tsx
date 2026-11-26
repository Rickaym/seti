import { checkComposer, confirmationFor, type StartAgentInput, type Task } from '@seti/shared'
import { ArrowUp, Loader2, ShieldCheck, ShieldOff } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { apiSend, errorText } from '@/api'
import { Hint } from '@/components/Hint'
import { BackButton } from '@/components/SplitPane'
import { MessageFindBar } from '@/components/find/FindBar'
import { FindButton } from '@/components/find/FindButton'
import { useFind } from '@/components/find/useFind'
import { Button } from '@/components/ui/button'
import { useConfirm } from '@/components/ui/confirm-context'
import { useAttachments } from '@/hooks/useAttachments'
import { useCapabilities } from '@/hooks/useCapabilities'
import { RETRYING_LABEL, useClientSend } from '@/hooks/useClientSend'
import { useCommandCatalog } from '@/hooks/useCommandCatalog'
import { useDraft } from '@/hooks/useDraft'
import { useCoarsePointer } from '@/hooks/useMedia'
import { useStartPick } from '@/hooks/useStartPick'
import { useSystem } from '@/hooks/useSystem'
import { useTasks } from '@/hooks/useTasks'
import { useUserName } from '@/hooks/useUserName'
import { useCurrentWorkspace } from '@/hooks/useWorkspaces'
import { withTokens } from '@/lib/attachments'
import { NEW_TASK_PROMPT } from '@/lib/drafts'
import { navigate } from '@/lib/route'
import { pickFields } from '@/lib/runtime-pick'
import { AttachButton, DraftAttachments } from '@/panels/tasks/AttachmentChips'
import { CommandField, ComposerStatus } from '@/panels/tasks/CommandField'
import { ModelPicker } from '@/panels/tasks/ModelPicker'

const HINT = 'Enter starts it, Ctrl+Enter adds a line. It works in its own folder and clones what it needs.'
const TOUCH_HINT = 'It works in its own folder and clones what it needs.'
const UNSANDBOXED = 'Starts outside the sandbox, with your access to every file, host and credential.'
const SHELL_IN_PROMPT =
  'Shell commands only run in an existing agent, so the new agent gets this as a message. Start anyway?'

/** The new agent joins the workspace the list shows. */
const inWorkspace = (input: StartAgentInput, workspaceId: string | null): StartAgentInput =>
  workspaceId === null ? input : { ...input, workspace_id: workspaceId }

/** What the composer says while idle: a start on Codex or unsandboxed says so first. */
function idleHint(sandboxed: boolean, touch: boolean, runtimeHint: string | null): string {
  if (runtimeHint !== null) {
    return runtimeHint
  }
  if (!sandboxed) {
    return UNSANDBOXED
  }
  return touch ? TOUCH_HINT : HINT
}

interface SandboxToggleProps {
  on: boolean
  onChange: (on: boolean) => void
  disabled: boolean
}

/** The new agent's sandbox: on unless the user turns it off; hidden while off in settings. */
function SandboxToggle({ on, onChange, disabled }: SandboxToggleProps) {
  if (!(useSystem().data?.sandbox.enabled ?? true)) {
    return null
  }
  return (
    <Hint
      text={
        on
          ? 'Sandboxed: it sees only its folders and reaches only the listed hosts. Click to start it without.'
          : 'Unsandboxed: it runs on the host with your access. Click to sandbox it.'
      }
    >
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Sandbox"
        aria-pressed={on}
        disabled={disabled}
        className="shrink-0 aria-pressed:text-primary pointer-coarse:size-10"
        onClick={() => {
          onChange(!on)
        }}
      >
        {on ? <ShieldCheck /> : <ShieldOff />}
      </Button>
    </Hint>
  )
}

/** Older installs stored "there" when git had no name, so it greets nobody in particular. */
function greeting(name: string | null): string {
  const named = name?.trim() ?? ''
  return named === '' || named.toLowerCase() === 'there' ? 'Your move' : `Your move, ${named}`
}

/** The start of every agent: one message, and Seti sets the rest up. */
export function StartPage() {
  const name = useUserName()
  const confirm = useConfirm()
  const touch = useCoarsePointer()
  const { refresh } = useTasks()
  const { currentId } = useCurrentWorkspace()
  const [prompt, setPrompt] = useDraft(NEW_TASK_PROMPT, '')
  const attachments = useAttachments(NEW_TASK_PROMPT, prompt, setPrompt)
  const find = useFind()
  const [starting, setStarting] = useState(false)
  const [sandboxed, setSandboxed] = useState(true)
  const { pick, setPick, runtimeHint } = useStartPick()
  const canUnsandbox = useCapabilities(pick)?.unsandboxed !== false
  const clientSend = useClientSend()
  const commands = useCommandCatalog('/commands', prompt.trimStart().startsWith('/'))
  const check = checkComposer(prompt, commands.commands)
  const files = attachments.items.length
  const ready = (prompt.trim() !== '' || files > 0) && !starting && attachments.pending === null

  const start = async () => {
    if (!ready) {
      return
    }
    const question = check.kind === 'shell' ? SHELL_IN_PROMPT : confirmationFor(check)
    if (
      question !== null &&
      !(await confirm({ title: 'Check the message', message: question, confirmLabel: 'Start anyway' }))
    ) {
      return
    }
    setStarting(true)
    try {
      const body = {
        ...inWorkspace(attachments.message(prompt), currentId),
        ...(sandboxed || !canUnsandbox ? {} : { sandbox: false }),
        ...pickFields(pick),
      }
      const task = await clientSend.run(JSON.stringify(body), async (clientId, options) =>
        apiSend<Task>('/tasks/start', { ...body, client_id: clientId }, options),
      )
      attachments.sent()
      setPrompt('')
      setSandboxed(true)
      refresh()
      navigate('agents', task.id, { force: true })
    } catch (e) {
      toast.error(errorText(e))
      setStarting(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-3 pt-2 md:hidden">
        <BackButton section="agents" label="agents" />
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-4">
        <h1 className="text-center text-2xl font-medium tracking-tight max-md:text-xl">{greeting(name)}</h1>
      </div>
      <div className="shrink-0 px-4 pb-4 max-md:px-2 max-md:pb-2">
        <div className="mx-auto w-full max-w-2xl space-y-2">
          <div className="relative border border-border bg-card focus-within:border-ring">
            {files > 0 && (
              <div className="px-2 pt-2">
                <DraftAttachments attachments={attachments} />
              </div>
            )}
            <MessageFindBar find={find} editable={!starting} />
            <CommandField
              value={prompt}
              onChange={setPrompt}
              commands={commands}
              label="Message"
              placeholder="What should the agent do?"
              rows={3}
              disabled={starting}
              placement="above"
              primary
              onSubmit={() => void start()}
              enterSends={!touch}
              attach={{ text: attachments.addText, files: attachments.addFiles }}
              find={find}
              className="min-h-20 border-0 px-3 py-3 text-sm focus-visible:ring-0 md:text-sm dark:bg-transparent"
            />
            <div className="flex items-end gap-1 px-2 pb-2">
              <ModelPicker pick={pick} onChange={setPick} disabled={starting} />
              <div className="ml-auto flex shrink-0 items-center gap-1">
                {canUnsandbox && <SandboxToggle on={sandboxed} onChange={setSandboxed} disabled={starting} />}
                {touch && <FindButton find={find} />}
                <AttachButton
                  disabled={starting}
                  onFiles={(chosen) => {
                    setPrompt(withTokens(prompt, attachments.addFiles(chosen)))
                  }}
                />
                <Hint text={touch ? 'Start the agent' : 'Start the agent (Enter)'}>
                  <Button
                    size="icon-sm"
                    className="shrink-0 pointer-coarse:size-10"
                    aria-label="Start agent"
                    disabled={!ready}
                    onClick={() => void start()}
                  >
                    {starting ? <Loader2 className="animate-spin" /> : <ArrowUp />}
                  </Button>
                </Hint>
              </div>
            </div>
          </div>
          {starting ? (
            <p role="status" className="px-1 text-2xs text-muted-foreground">
              {clientSend.retrying ? RETRYING_LABEL : 'Setting up the agent: picking context and tools...'}
            </p>
          ) : (
            <ComposerStatus
              check={check}
              commands={commands}
              shellCwd={null}
              idle={attachments.pending ?? idleHint(sandboxed, touch, runtimeHint)}
            />
          )}
        </div>
      </div>
    </div>
  )
}
