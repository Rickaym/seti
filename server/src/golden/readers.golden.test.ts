import { closingQuestion, projectClaude, type MessageRow, rowEvents } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { ShellIndex } from '../background-shells.js'
import { buildDigest, toolLabel } from '../digest.js'
import { outwardCalls } from '../outward.js'
import { transcriptEvidence } from '../pr-evidence.js'
import { deriveSubtasks } from '../subtasks.js'
import { deriveTodos } from '../todos.js'
import { turnBlocks } from '../turn-asking.js'
import { goldenCorpus, type GoldenTranscript } from './corpus.js'
import { asciiJson } from './json.js'

const corpus = goldenCorpus()

const sdkPayloads = (rows: readonly MessageRow[]) => rows.flatMap((row) => (row.kind === 'sdk' ? [row.payload] : []))

/** Todos, subtasks and background shells as they stood after each turn of the transcript. */
function afterTurns(rows: readonly MessageRow[]) {
  const shells = new ShellIndex()
  return rows.flatMap((row, index) => {
    shells.apply(row)
    if (row.kind !== 'sdk' || row.payload.type !== 'result') {
      return []
    }
    const before = rows.slice(0, index + 1)
    return [
      { row: row.id, todos: deriveTodos(before), subtasks: deriveSubtasks(before, null), shells: shells.shells(null) },
    ]
  })
}

/** What the server's transcript readers make of one transcript, as the user would see it. */
function render({ rows }: GoldenTranscript) {
  const subtasks = deriveSubtasks(rows, null)
  const stored = rows.flatMap((row) =>
    row.kind === 'unreadable' ? [] : [{ kind: row.kind, payload: JSON.stringify(row.payload) }],
  )
  const evidence = transcriptEvidence(stored)
  const payloads = sdkPayloads(rows)
  const own = payloads.filter((m) => m.type === 'assistant' && m.parent_tool_use_id === null)
  return {
    digest: buildDigest(rows, subtasks),
    turns: afterTurns(rows),
    outward: payloads.flatMap((m) => outwardCalls(projectClaude(m))),
    prs: { created: [...evidence.created], pushedTo: [...evidence.pushedTo], pushes: evidence.pushes },
    asks: closingQuestion(turnBlocks(own.map((m) => JSON.stringify(m)))),
    labels: rows.flatMap((row) =>
      rowEvents(row).flatMap((e) => (e.type === 'tool.started' ? [toolLabel(e.call)] : [])),
    ),
  }
}

/** Message shapes a reader reads, which must project to more than `vendor`. */
const READ = new Set(['assistant', 'user', 'result', 'system/init', 'system/status', 'system/compact_boundary'])

describe('golden transcripts', () => {
  it('are the recorded corpus the UI golden test reads', async () => {
    await expect(asciiJson(corpus)).toMatchFileSnapshot('./corpus.golden.json')
  })

  it('render through the server readers as recorded', async () => {
    const rendered = Object.fromEntries(corpus.map((transcript) => [transcript.name, render(transcript)]))
    await expect(asciiJson(rendered)).toMatchFileSnapshot('./server-readers.golden.json')
  })

  it('project every message a reader reads to neutral events', () => {
    for (const m of corpus.flatMap((transcript) => sdkPayloads(transcript.rows))) {
      const shape = m.type === 'system' ? `system/${m.subtype}` : m.type
      const events = projectClaude(m)
      expect(events.length, shape).toBeGreaterThan(0)
      if (READ.has(shape) || shape.startsWith('system/task_')) {
        expect(
          events.filter((event) => event.type === 'vendor'),
          shape,
        ).toEqual([])
      }
    }
  })
})
