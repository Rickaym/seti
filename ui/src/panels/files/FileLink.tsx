import { fileUrlTarget, type ResolvedPath } from '@seti/shared'
import { FolderOpen } from 'lucide-react'
import type { ReactNode } from 'react'
import { Hint } from '@/components/Hint'
import type { FileMentionProps } from '@/components/Markdown'
import { Button } from '@/components/ui/button'
import { FileCard } from '@/panels/files/FileCard'
import { FileMention } from '@/panels/files/FileMention'
import { useFileLinks, useResolvedPath } from '@/panels/files/file-links'

const LINE_SUFFIX = /:\d+(?::\d+)?$/

/** The path as written, unless it was a link, whose path within its root reads better. */
const shownPath = (found: ResolvedPath) =>
  fileUrlTarget(found.input) !== null || found.input.startsWith('file:') ? found.path : found.input.trim()

const lineOf = (children: ReactNode) =>
  typeof children === 'string' ? (LINE_SUFFIX.exec(children)?.[0] ?? null) : null

/** A path or Files link in the text: a chip in a sentence, a card alone, plain text until found. */
export function FileLink({ path, children, card = false }: FileMentionProps) {
  const links = useFileLinks()
  const found = useResolvedPath(path)
  if (links === null || found === null) {
    return <>{children}</>
  }
  const open = () => {
    links.open(found)
  }
  if (card) {
    return <FileCard found={found} shown={shownPath(found)} taskId={found.task_id ?? links.taskId} onOpen={open} />
  }
  return <FileMention found={found} shown={shownPath(found)} line={lineOf(children)} onOpen={open} />
}

/** Opens the file a tool call touched, from inside the call's summary line. */
export function ToolFileButton({ path }: { path: string }) {
  const links = useFileLinks()
  const found = useResolvedPath(path)
  if (links === null || found === null) {
    return null
  }
  return (
    <Hint text={`Open ${found.path} in Files`}>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={`Open ${found.path} in Files`}
        className="-my-1 shrink-0"
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          links.open(found)
        }}
      >
        <FolderOpen />
      </Button>
    </Hint>
  )
}
