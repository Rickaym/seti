import type { ToolCall } from '@seti/shared'
import { useTasks } from '@/hooks/useTasks'
import { fullCommandText, inputString, type ToolUseBlock } from '@/lib/transcript'
import { TrimmedText, type FullSource } from '@/panels/tasks/TrimmedText'

const COMMAND_KEYS = new Set(['command', 'description'])

/** The input of a shell call: its description, the full command to copy, and any other options. */
function CommandInput({ block, source, taskId }: InputProps) {
  const { tasks } = useTasks()
  const cwd = tasks.find((task) => task.id === taskId)?.cwd
  const command = inputString(block.input, 'command') ?? ''
  const description = inputString(block.input, 'description')
  const options =
    typeof block.input === 'object' && block.input !== null
      ? Object.entries(block.input).filter(
          ([key, value]) => !COMMAND_KEYS.has(key) && !(key === 'cwd' && value === cwd),
        )
      : []
  return (
    <>
      {description !== undefined && <p className="text-muted-foreground">{description}</p>}
      <TrimmedText
        text={command}
        source={source === null ? null : { ...source, pick: fullCommandText }}
        label="Full command"
        className="max-h-64 border border-border bg-background/60 py-1.5 pr-8 pl-2"
        copy="Copy command"
        language="bash"
      />
      {options.length > 0 && (
        <p className="text-muted-foreground">
          {options.map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join(' | ')}
        </p>
      )}
    </>
  )
}

type Change = NonNullable<ToolCall['edit']>['changes'][number]

/** An edit given as patches rather than as old and new text: each file with its diff. */
function PatchInput({ changes }: { changes: readonly Change[] }) {
  return (
    <>
      {changes.map((change) => (
        <div key={change.path} className="space-y-1" data-testid="edit-change">
          <p className="break-all text-muted-foreground">
            {change.to === undefined ? change.path : `${change.path} -> ${change.to}`}
          </p>
          {change.diff !== undefined && change.diff !== '' && (
            <TrimmedText
              text={change.diff}
              source={null}
              label="Full diff"
              className="max-h-64"
              copy="Copy diff"
              language="diff"
            />
          )}
        </div>
      ))}
    </>
  )
}

interface InputProps {
  block: ToolUseBlock
  source: FullSource | null
  taskId: string
}

/** A call's input: a command, an edit's patches, or the input as written. */
export function CallInput({ block, source, taskId }: InputProps) {
  if (inputString(block.input, 'command') !== undefined) {
    return <CommandInput block={block} source={source} taskId={taskId} />
  }
  const patches = inputString(block.input, 'file_path') === undefined ? (block.edit?.changes ?? []) : []
  if (patches.length > 0) {
    return <PatchInput changes={patches} />
  }
  return (
    <TrimmedText text={JSON.stringify(block.input, null, 2)} source={source} label="Full input" className="max-h-64" />
  )
}
