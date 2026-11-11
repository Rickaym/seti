import type { SDKAssistantMessage } from '@anthropic-ai/claude-agent-sdk'
import type { MessageRow, SubtaskBrief, TaskRewind } from '@seti/shared'
import { FoldVertical, Terminal } from 'lucide-react'
import { Fragment, lazy, memo, Suspense, useMemo } from 'react'
import { CopyReply } from '@/components/CopyReply'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { useToolGrouping } from '@/hooks/useToolGrouping'
import { compactFailure } from '@/lib/compacting'
import { interruptedResultIds } from '@/lib/interruptions'
import { transcriptItems } from '@/lib/rewind'
import { openFailure } from '@/lib/seti-notes'
import { isAgentTool } from '@/lib/subtasks'
import { rowRole, transcriptViews, type RoleContext, type Segment, type TranscriptView } from '@/lib/tool-groups'
import { startsBackground } from '@/lib/tool-summary'
import {
  indexTranscript,
  localCommandOutput,
  queuedInputIds,
  rendersContent,
  rowCalls,
  rowResults,
  shellDeliveries,
  subagentOf,
  turnReplies,
  type BackgroundStatus,
  type ShellDelivery,
  type ToolResultRef,
  type ToolUseBlock,
} from '@/lib/transcript'
import {
  anchorsOf,
  NO_BLOCKS,
  placeBlocks,
  viewStart,
  type LoadedEdges,
  type TimedBlock,
} from '@/lib/transcript-blocks'
import { FileLink } from '@/panels/files/FileLink'
import { useFileLinks } from '@/panels/files/file-links'
import { ASK_TOOL, QuestionCall } from '@/panels/questions/QuestionCall'
import { InputEntry } from '@/panels/tasks/InputEntry'
import { NoticeEntry } from '@/panels/tasks/NoticeEntry'
import { PromptEntry } from '@/panels/tasks/PromptEntry'
import { RewindNote, RewoundGroup } from '@/panels/tasks/Rewound'
import { SetiNote } from '@/panels/tasks/SetiNote'
import { ShellEntry } from '@/panels/tasks/ShellEntry'
import { SubtaskCard } from '@/panels/tasks/SubtaskCard'
import { OrphanResult, ToolCall } from '@/panels/tasks/ToolCall'
import { ToolGroup } from '@/panels/tasks/ToolGroup'
import { TranscriptBlocks } from '@/panels/tasks/TranscriptBlocks'
import { CompactLine, InitLine, Line, ResultLine } from '@/panels/tasks/TranscriptLines'
import { NoteLine, Spoken, type TranscriptMarks } from '@/panels/tasks/TranscriptMarks'

const Markdown = lazy(async () => import('@/components/Markdown').then((m) => ({ default: m.Markdown })))

type LinkedResults = readonly (ToolResultRef | undefined)[]
type LinkedSubtasks = readonly (SubtaskBrief | undefined)[]
type LinkedBackground = readonly (BackgroundStatus | undefined)[]

const NONE: readonly ToolResultRef[] = []
const NO_SUBTASKS: LinkedSubtasks = []
const NO_BACKGROUND: LinkedBackground = []
const NO_DELIVERIES = new Map<number, ShellDelivery>()
const NO_MARKS: TranscriptMarks = { voice: new Set(), notes: new Map() }
const ALL_LOADED: LoadedEdges = { hasOlder: false, hasNewer: false }

export function AgentText({ text }: { text: string }) {
  const links = useFileLinks()
  return (
    <CopyReply text={text} touch={false}>
      <div data-find-text="">
        <Suspense fallback={<div className="text-sm leading-relaxed whitespace-pre-wrap">{text}</div>}>
          <Markdown text={text} fileLink={links === null ? undefined : FileLink} />
        </Suspense>
      </div>
    </CopyReply>
  )
}

interface RowProps {
  taskId: string
  row: MessageRow
  /** Left out: a repeated session start, or the failure the notice under the transcript shows. */
  hidden: boolean
  /** Results of this row's tool calls, in call order. */
  results: LinkedResults
  /** Subtasks this row's Agent calls started, in call order. */
  subtasks: LinkedSubtasks
  /** Background processes this row's calls started, in call order. */
  background: LinkedBackground
  /** Show subagent messages, which the task's own transcript leaves to subtask cards. */
  subagentRows: boolean
  /** Results in this row whose calls are not loaded. */
  orphans: readonly ToolResultRef[]
  running: boolean
  /** An update the agent has not read yet. */
  queued: boolean
  /** Whether this shell run goes to the agent with the next message. */
  shell: ShellDelivery | undefined
  /** A result of a turn that a later message interrupted. */
  interrupted: boolean
  /** Spoken on a call rather than typed. */
  voice: boolean
  /** The reply of the turn this result row ends. */
  reply: string | undefined
}

function AssistantMessage({ props, message }: { props: RowProps; message: SDKAssistantMessage }) {
  const { taskId, row, results, subtasks, background, running } = props
  const outward = new Set(row.outward)
  const trimmed = new Set(row.trimmed)
  let call = 0
  return (
    <div className="space-y-2">
      {message.message.content.map((block, index) => {
        const key = `${message.uuid}-${String(index)}`
        if (block.type === 'text' && block.text.trim() !== '') {
          return (
            <Spoken key={key} voice={props.voice}>
              <AgentText text={block.text} />
            </Spoken>
          )
        }
        if (block.type !== 'tool_use') {
          return null
        }
        const result = results[call]
        const subtask = subtasks[call]
        const process = background[call]
        call++
        if (block.name === ASK_TOOL) {
          return <QuestionCall key={key} taskId={taskId} block={block} done={result !== undefined} />
        }
        if (isAgentTool(block.name)) {
          return (
            <SubtaskCard
              key={key}
              taskId={taskId}
              rowId={row.id}
              startedAt={row.created_at}
              block={block}
              result={result}
              subtask={subtask}
              inputTrimmed={trimmed.has(block.id)}
            />
          )
        }
        return (
          <ToolCall
            key={key}
            taskId={taskId}
            rowId={row.id}
            startedAt={row.created_at}
            block={block}
            result={result}
            outward={outward.has(block.id)}
            inputTrimmed={trimmed.has(block.id)}
            running={running}
            background={process}
          />
        )
      })}
    </div>
  )
}

function rowVisible({ row, hidden, orphans, subagentRows }: RowProps): boolean {
  if (hidden) {
    return false
  }
  if (row.kind !== 'sdk') {
    return true
  }
  if (!subagentRows && subagentOf(row) !== null) {
    return false
  }
  const { payload } = row
  if (payload.type === 'system' && payload.subtype === 'init') {
    return true
  }
  return rendersContent(row) || orphans.length > 0
}

/** A row too malformed to judge shows, so its boundary can say it could not be shown. */
function shown(props: RowProps): boolean {
  try {
    return rowVisible(props)
  } catch {
    return true
  }
}

/** A row that is not an SDK message: a prompt, an update, a notice, an error or a shell run. */
function PlainRow({ props, row }: { props: RowProps; row: Exclude<MessageRow, { kind: 'sdk' }> }) {
  switch (row.kind) {
    case 'prompt':
      return <PromptEntry taskId={props.taskId} row={row} voice={props.voice} />
    case 'input':
      return <InputEntry taskId={props.taskId} input={row.payload} queued={props.queued} />
    case 'notice':
      return <NoticeEntry notice={row.payload} />
    case 'seti':
      return <SetiNote payload={row.payload} />
    case 'shell':
      return <ShellEntry taskId={props.taskId} row={row} result={row.payload} delivery={props.shell} />
    case 'unreadable':
      throw new Error(`Stored ${row.payload.kind} message does not fit its kind: ${row.payload.reason}`)
  }
}

function RowBody(props: RowProps) {
  const { row, taskId, orphans } = props
  if (row.kind !== 'sdk') {
    return <PlainRow props={props} row={row} />
  }
  const { payload } = row
  if (payload.type === 'system' && payload.subtype === 'init') {
    return <InitLine message={payload} />
  }
  if (payload.type === 'assistant') {
    return <AssistantMessage props={props} message={payload} />
  }
  if (payload.type === 'result') {
    return <ResultLine message={payload} interrupted={props.interrupted} reply={props.reply} />
  }
  if (payload.type === 'system' && payload.subtype === 'compact_boundary') {
    return <CompactLine message={payload} />
  }
  const failure = compactFailure(row)
  if (failure !== null) {
    return (
      <Line icon={FoldVertical} error>
        compaction failed: {failure}
      </Line>
    )
  }
  const local = payload.type === 'user' ? localCommandOutput(payload) : null
  if (local !== null) {
    return (
      <Line icon={Terminal}>
        <span className="font-mono whitespace-pre-wrap">{local === '' ? 'command done' : local}</span>
      </Line>
    )
  }
  return (
    <div className="space-y-2">
      {orphans.map((result) => (
        <OrphanResult key={result.block.tool_use_id} taskId={taskId} result={result} />
      ))}
    </div>
  )
}

const sameItems = <T,>(a: readonly T[], b: readonly T[]) =>
  a.length === b.length && a.every((item, index) => item === b[index])

const sameRow = (a: RowProps, b: RowProps) =>
  a.row === b.row &&
  a.taskId === b.taskId &&
  a.hidden === b.hidden &&
  a.running === b.running &&
  a.queued === b.queued &&
  a.shell === b.shell &&
  a.interrupted === b.interrupted &&
  a.voice === b.voice &&
  a.reply === b.reply &&
  a.subagentRows === b.subagentRows &&
  sameItems(a.results, b.results) &&
  sameItems(a.subtasks, b.subtasks) &&
  sameItems(a.background, b.background) &&
  sameItems(a.orphans, b.orphans)

/** One message; re-renders only when its own row or linked results change. */
const TranscriptRow = memo(function MessageView(props: RowProps) {
  return shown(props) ? (
    <div
      data-message-id={props.row.id}
      data-orphan={props.orphans.length > 0 ? '' : undefined}
      data-find-text={props.row.kind === 'input' ? '' : undefined}
    >
      <ErrorBoundary name={`Message ${String(props.row.id)}`} kind="row" resetKey={props.row}>
        <RowBody {...props} />
      </ErrorBoundary>
    </div>
  ) : null
}, sameRow)

export const Transcript = memo(function TranscriptList({
  taskId,
  messages,
  rewinds,
  running,
  subtasks,
  subagentRows,
  marks = NO_MARKS,
  blocks,
  edges = ALL_LOADED,
}: {
  taskId: string
  messages: readonly MessageRow[]
  rewinds: readonly TaskRewind[]
  running: boolean
  subtasks: readonly SubtaskBrief[]
  subagentRows: boolean
  marks?: TranscriptMarks
  /** Blocks mods draw among the rows by time, such as asides. */
  blocks?: readonly TimedBlock[] | undefined
  /** What the loaded rows leave out, so a block outside them waits for its page. */
  edges?: LoadedEdges
}) {
  const [grouping] = useToolGrouping()
  const index = useMemo(() => indexTranscript(messages), [messages])
  const byCall = useMemo(() => new Map(subtasks.map((subtask) => [subtask.tool_use_id, subtask])), [subtasks])
  const items = useMemo(() => transcriptItems(messages, rewinds), [messages, rewinds])
  // Subtask transcripts hold no prompts, so they cannot tell which updates the parent read.
  const queued = useMemo(() => (subagentRows ? new Set<number>() : queuedInputIds(messages)), [messages, subagentRows])
  const shell = useMemo(() => (subagentRows ? NO_DELIVERIES : shellDeliveries(messages)), [messages, subagentRows])
  const interrupted = useMemo(() => interruptedResultIds(messages, running), [messages, running])
  const replies = useMemo(() => turnReplies(messages), [messages])
  const failure = useMemo(() => (subagentRows ? null : openFailure(messages)), [messages, subagentRows])
  const views = useMemo(() => {
    const context: RoleContext = { ...index, subagentRows, notes: marks.notes }
    return transcriptViews(items, grouping ? (row) => rowRole(row, context) : null)
  }, [items, index, subagentRows, marks.notes, grouping])
  const placed = useMemo(
    () => (blocks === undefined ? NO_BLOCKS : placeBlocks(anchorsOf(views), blocks, edges)),
    [views, blocks, edges],
  )

  const backgroundOf = (calls: readonly ToolUseBlock[]) =>
    calls.some(startsBackground)
      ? calls.map((call) => (startsBackground(call) ? index.background.get(call.id) : undefined))
      : NO_BACKGROUND

  const renderRow = (row: MessageRow) => {
    const calls = rowCalls(row)
    const results = calls.length === 0 ? NONE : calls.map((call) => index.results.get(call.id))
    const started = calls.some((call) => isAgentTool(call.name))
      ? calls.map((call) => byCall.get(call.id))
      : NO_SUBTASKS
    const orphans = rowResults(row).filter((ref) => !index.calls.has(ref.block.tool_use_id))
    const note = marks.notes.get(row.id)
    const view = (
      <TranscriptRow
        key={row.id}
        taskId={taskId}
        row={row}
        hidden={index.hiddenInits.has(row.id) || row.id === failure || interrupted.get(row.id) === 'replaced'}
        results={results}
        subtasks={started}
        background={backgroundOf(calls)}
        subagentRows={subagentRows}
        orphans={orphans.length === 0 ? NONE : orphans}
        running={running && results.some((result) => result === undefined)}
        queued={queued.has(row.id)}
        shell={shell.get(row.id)}
        interrupted={interrupted.has(row.id)}
        voice={marks.voice.has(row.id)}
        reply={replies.get(row.id)}
      />
    )
    return note === undefined ? (
      view
    ) : (
      <Fragment key={row.id}>
        <NoteLine note={note} />
        {view}
      </Fragment>
    )
  }

  const renderSegment = (segment: Segment) => {
    if (segment.type === 'row') {
      return renderRow(segment.row)
    }
    const calls = segment.rows.flatMap(rowCalls)
    const results = calls.map((call) => index.results.get(call.id))
    return (
      <ToolGroup
        key={`tools-${String(segment.rows[0]?.id ?? 0)}`}
        rows={segment.rows}
        results={results}
        background={backgroundOf(calls)}
        running={running && results.some((result) => result === undefined)}
        renderRow={renderRow}
      />
    )
  }

  const renderView = (view: TranscriptView) => {
    if (view.type === 'row' || view.type === 'tools') {
      return renderSegment(view)
    }
    if (view.type === 'note') {
      return <RewindNote key={`note-${String(view.rewind.id)}`} rewind={view.rewind} />
    }
    const first = view.rows[0]?.id ?? 0
    return (
      <RewoundGroup
        key={`rewound-${String(view.rewind.id)}-${String(first)}`}
        rewind={view.rewind}
        rows={view.rows}
        count={view.count}
      >
        {view.segments.map(renderSegment)}
      </RewoundGroup>
    )
  }

  return (
    <div className="space-y-3">
      {views.map((view) => {
        const first = viewStart(view)?.id
        const before = first === undefined ? undefined : placed.before.get(first)
        return before === undefined ? (
          renderView(view)
        ) : (
          <Fragment key={`blocks-${String(first)}`}>
            <TranscriptBlocks agent={taskId} blocks={before} />
            {renderView(view)}
          </Fragment>
        )
      })}
      <TranscriptBlocks agent={taskId} blocks={placed.after} />
    </div>
  )
})
