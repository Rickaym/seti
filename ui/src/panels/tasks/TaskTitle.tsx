import type { Task } from '@seti/shared'
import { Pencil, PencilLine } from 'lucide-react'
import { useEffect, useRef, type KeyboardEvent } from 'react'
import { toast } from 'sonner'
import { apiPatch, errorText } from '@/api'
import { Hint } from '@/components/Hint'
import { DetailTitle } from '@/components/SplitPane'
import { useCommands } from '@/components/palette/useCommands'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { refreshTaskLists } from '@/hooks/useTasks'

const TITLE_MAX = 200

interface TaskTitleProps {
  task: Pick<Task, 'id' | 'title'>
  onChanged: () => void
  /** The name being typed, or null while not renaming; held by the header so a menu can start it. */
  draft: string | null
  onDraftChange: (draft: string | null) => void
  /** One truncated line and no pencil, for the phone header whose actions menu offers Rename. */
  compact?: boolean
}

/** The agent's name in its header; the pencil edits it in place. */
export function TaskTitle({ task, onChanged, draft, onDraftChange: setDraft, compact = false }: TaskTitleProps) {
  const input = useRef<HTMLInputElement>(null)
  const editing = draft !== null

  useCommands([
    {
      id: 'agent.rename',
      title: 'Rename agent',
      detail: task.title,
      icon: PencilLine,
      group: 'Current agent',
      keywords: 'title name',
      when: (context) => context.agent?.id === task.id,
      run: () => {
        setDraft(task.title)
      },
    },
  ])

  useEffect(() => {
    if (editing) {
      input.current?.select()
    }
  }, [editing])

  const save = async () => {
    const title = (draft ?? '').trim()
    setDraft(null)
    if (title === '' || title === task.title) {
      return
    }
    try {
      await apiPatch<Task>(`/tasks/${task.id}`, { title })
      toast.success(`Renamed to "${title}"`)
      onChanged()
      refreshTaskLists()
    } catch (e) {
      toast.error(errorText(e))
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void save()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      setDraft(null)
    }
  }

  if (editing) {
    return (
      <Input
        ref={input}
        aria-label="Agent name"
        className="h-8 min-w-0 flex-1 text-lg font-semibold max-md:text-base"
        maxLength={TITLE_MAX}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value)
        }}
        onKeyDown={onKeyDown}
        onBlur={() => void save()}
      />
    )
  }

  if (compact) {
    return <DetailTitle oneLine>{task.title}</DetailTitle>
  }
  return (
    <>
      <DetailTitle>{task.title}</DetailTitle>
      <Hint text="Rename agent; its group chat handle stays">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Rename agent"
          className="-ml-1 shrink-0 text-muted-foreground"
          onClick={() => {
            setDraft(task.title)
          }}
        >
          <Pencil />
        </Button>
      </Hint>
    </>
  )
}
