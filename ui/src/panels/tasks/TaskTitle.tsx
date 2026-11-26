import type { Task } from '@seti/shared'
import { Pencil } from 'lucide-react'
import { useEffect, useRef, type KeyboardEvent } from 'react'
import { Hint } from '@/components/Hint'
import { DetailTitle } from '@/components/SplitPane'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { renameTask } from '@/panels/tasks/rename'

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
    await renameTask(task, title, onChanged)
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
