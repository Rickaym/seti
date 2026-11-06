import { checkComposer, confirmationFor, type AttachmentRef, type StartAgentInput, type Task } from '@seti/shared'
import { ArrowUp, GitPullRequest, Loader2, X } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { apiSend, errorText } from '@/api'
import { Hint } from '@/components/Hint'
import { BackButton } from '@/components/SplitPane'
import { Button } from '@/components/ui/button'
import { useConfirm } from '@/components/ui/confirm-context'
import { useAttachments } from '@/hooks/useAttachments'
import { RETRYING_LABEL, useClientSend } from '@/hooks/useClientSend'
import { useCommandCatalog } from '@/hooks/useCommandCatalog'
import { useDraft } from '@/hooks/useDraft'
import { useCoarsePointer } from '@/hooks/useMedia'
import { useTasks } from '@/hooks/useTasks'
import { useUserName } from '@/hooks/useUserName'
import { useCurrentWorkspace } from '@/hooks/useWorkspaces'
import { withTokens } from '@/lib/attachments'
import { NEW_TASK_PROMPT } from '@/lib/drafts'
import { navigate } from '@/lib/route'
import { clearStartContext, startContext, type StartContext } from '@/lib/start-context'
import { cn } from '@/lib/utils'
import { AttachButton, DraftAttachments } from '@/panels/tasks/AttachmentChips'
import { CommandField, ComposerStatus } from '@/panels/tasks/CommandField'

const RECENT_REPOS = 4
const HINT = 'Enter starts it, Ctrl+Enter adds a line. Seti picks the repos, context and tools.'
const TOUCH_HINT = 'Seti picks the repos, context and tools; change them later.'
const SHELL_IN_PROMPT =
  'Shell commands only run in an existing agent, so the new agent gets this as a message. Start anyway?'

interface RecentRepo {
  id: string
  slug: string
}

/** Repos of the most recently active agents, newest first. */
function useRecentRepos(): RecentRepo[] {
  const { tasks } = useTasks()
  const seen = new Map<string, RecentRepo>()
  for (const task of tasks.toSorted((a, b) => b.updated_at.localeCompare(a.updated_at))) {
    for (const repo of task.repos) {
      if (!seen.has(repo.id)) {
        seen.set(repo.id, { id: repo.id, slug: repo.slug })
      }
    }
  }
  return [...seen.values()].slice(0, RECENT_REPOS)
}

const repoName = (slug: string) => slug.slice(slug.indexOf('/') + 1)

function RepoChips({ picked, onToggle }: { picked: readonly string[]; onToggle: (id: string) => void }) {
  const recent = useRecentRepos()
  if (recent.length === 0) {
    return null
  }
  return (
    <div role="group" aria-label="Recent repos" className="flex min-w-0 flex-wrap items-center gap-1.5">
      {recent.map((repo) => (
        <Hint
          key={repo.id}
          text={picked.includes(repo.id) ? `Runs in ${repo.slug}` : `Work in ${repo.slug} instead of letting Seti pick`}
        >
          <button
            type="button"
            aria-pressed={picked.includes(repo.id)}
            aria-label={repo.slug}
            onClick={() => {
              onToggle(repo.id)
            }}
            className={cn(
              'max-w-40 truncate border border-border px-2 py-0.5 text-2xs text-muted-foreground hover:bg-accent hover:text-foreground',
              'aria-pressed:border-primary aria-pressed:text-foreground pointer-coarse:py-1.5',
            )}
          >
            {repoName(repo.slug)}
          </button>
        </Hint>
      ))}
    </div>
  )
}

function ContextChip({ context, onClear }: { context: StartContext; onClear: () => void }) {
  return (
    <span className="flex min-w-0 items-center gap-1 border border-primary px-2 py-0.5 text-2xs">
      <GitPullRequest className="size-3 shrink-0" />
      <span className="truncate">{context.label}</span>
      <button
        type="button"
        aria-label={`Drop ${context.label}`}
        className="text-muted-foreground hover:text-foreground"
        onClick={onClear}
      >
        <X className="size-3" />
      </button>
    </span>
  )
}

interface Message {
  prompt: string
  attachments?: AttachmentRef[]
}

function request(message: Message, context: StartContext | null, picked: readonly string[]): StartAgentInput {
  if (context !== null) {
    const { title, repo_ids, ref, pr_urls } = context
    return { ...message, title, repo_ids, ref, pr_urls }
  }
  return picked.length === 0 ? message : { ...message, repo_ids: [...picked] }
}

/** The new agent joins the workspace the list shows. */
const inWorkspace = (input: StartAgentInput, workspaceId: string | null): StartAgentInput =>
  workspaceId === null ? input : { ...input, workspace_id: workspaceId }

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
  const [context, setContext] = useState(startContext)
  const draftKey = context === null ? NEW_TASK_PROMPT : null
  const [prompt, setPrompt] = useDraft(draftKey, context?.prompt ?? '')
  const attachments = useAttachments(draftKey, prompt, setPrompt)
  const [picked, setPicked] = useState<string[]>([])
  const [starting, setStarting] = useState(false)
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
      const body = inWorkspace(request(attachments.message(prompt), context, picked), currentId)
      const task = await clientSend.run(JSON.stringify(body), async (clientId, options) =>
        apiSend<Task>('/tasks/start', { ...body, client_id: clientId }, options),
      )
      attachments.sent()
      setPrompt('')
      clearStartContext()
      refresh()
      navigate('agents', task.id, { force: true })
    } catch (e) {
      toast.error(errorText(e))
      setStarting(false)
    }
  }

  const toggle = (id: string) => {
    setPicked((prev) => (prev.includes(id) ? prev.filter((other) => other !== id) : [...prev, id]))
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
              className="min-h-20 border-0 px-3 py-3 text-sm focus-visible:ring-0 md:text-sm dark:bg-transparent"
            />
            <div className="flex items-end justify-between gap-3 px-2 pb-2">
              {context === null ? (
                <RepoChips picked={picked} onToggle={toggle} />
              ) : (
                <ContextChip
                  context={context}
                  onClear={() => {
                    clearStartContext()
                    setContext(null)
                  }}
                />
              )}
              <div className="ml-auto flex shrink-0 items-center gap-1">
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
              {clientSend.retrying ? RETRYING_LABEL : 'Setting up the agent: picking repos, context and tools...'}
            </p>
          ) : (
            <ComposerStatus
              check={check}
              commands={commands}
              shellCwd={null}
              idle={attachments.pending ?? (touch ? TOUCH_HINT : HINT)}
            />
          )}
        </div>
      </div>
    </div>
  )
}
