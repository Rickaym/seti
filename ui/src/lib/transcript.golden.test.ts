import fs from 'node:fs'
import path from 'node:path'
import { eventsOf, rowEvents, type MessageRow } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { askedInRows } from '@/lib/closing-question'
import { compactFailure, compactingSince } from '@/lib/compacting'
import { interruptedResultIds } from '@/lib/interruptions'
import { turnOutcome } from '@/lib/session-labels'
import { groupRows, rowRole, type RoleContext } from '@/lib/tool-groups'
import {
  commandLine,
  exitCode,
  groupLabel,
  refusals,
  startsBackground,
  toolKind,
  toolName,
  toolSummary,
} from '@/lib/tool-summary'
import {
  indexTranscript,
  localCommandOutput,
  rendersContent,
  resultText,
  rowCalls,
  rowResults,
  subagentOf,
  turnReplies,
} from '@/lib/transcript'

interface GoldenTranscript {
  name: string
  rows: MessageRow[]
}

const GOLDEN = path.resolve(import.meta.dirname, '../../../server/src/golden')
const corpus = JSON.parse(fs.readFileSync(path.join(GOLDEN, 'corpus.golden.json'), 'utf8')) as GoldenTranscript[]

const ids = (rows: readonly MessageRow[]) => rows.map((row) => row.id)

function groups(rows: readonly MessageRow[], subagentRows: boolean) {
  const index = indexTranscript(rows)
  const context: RoleContext = { hiddenInits: index.hiddenInits, calls: index.calls, subagentRows, notes: new Map() }
  return groupRows(rows, (row) => rowRole(row, context)).map((segment) =>
    segment.type === 'row' ? segment.row.id : { tools: ids(segment.rows), calls: segment.calls },
  )
}

const calls = (rows: readonly MessageRow[]) =>
  rows.flatMap(rowCalls).map((call) => ({
    id: call.callId,
    kind: toolKind(call),
    name: toolName(call.name),
    summary: toolSummary(call),
    command: commandLine(call) ?? null,
    background: startsBackground(call),
  }))

const results = (rows: readonly MessageRow[]) =>
  rows.flatMap(rowResults).map((ref) => {
    const text = resultText(ref)
    return { id: ref.callId, row: ref.rowId, exit: exitCode(text), refusals: refusals(text) }
  })

/** What the browser's transcript readers make of one transcript: what shows, how, and grouped how. */
function render({ rows }: GoldenTranscript) {
  const index = indexTranscript(rows)
  const sdk = rows.flatMap((row) => (row.kind === 'sdk' ? [{ id: row.id, row, payload: row.payload }] : []))
  return {
    shows: ids(rows.filter(rendersContent)),
    subagent: rows.flatMap((row) => (subagentOf(row) === null ? [] : [[row.id, subagentOf(row)]])),
    hiddenInits: [...index.hiddenInits],
    background: [...index.background],
    replies: [...turnReplies(rows)],
    groups: groups(rows, false),
    subagentGroups: groups(rows, true),
    calls: calls(rows),
    label: groupLabel(rows.flatMap(rowCalls)),
    results: results(rows),
    compactingSince: rows.map((_, end) => compactingSince(rows.slice(0, end + 1), true)),
    compactFailures: rows.flatMap((row) => (compactFailure(row) === null ? [] : [[row.id, compactFailure(row)]])),
    interrupted: [...interruptedResultIds(rows, false)],
    asked: askedInRows(rows),
    local: sdk.flatMap(({ id, row, payload }) => (payload.type === 'user' ? [[id, localCommandOutput(row)]] : [])),
    outcomes: sdk.flatMap(({ id, row }) =>
      eventsOf(rowEvents(row), 'turn.ended').map((end) => [id, turnOutcome(end, false)]),
    ),
  }
}

describe('golden transcripts in the browser', () => {
  it('render through the transcript readers as recorded', async () => {
    const rendered = Object.fromEntries(corpus.map((transcript) => [transcript.name, render(transcript)]))
    await expect(`${JSON.stringify(rendered, null, 2)}\n`).toMatchFileSnapshot('./transcript.golden.json')
  })
})
