import { commandStarted, turnEnded, turnStarted, type CodexRow } from './codex-rows.js'

const THREAD = 'e2e-codex-thread'

/** Something the agent said between its calls, so they show as rows of their own. */
const said = (id: string, text: string): CodexRow => ({
  method: 'item/completed',
  event: 'message',
  params: { threadId: THREAD, item: { type: 'agentMessage', id, text } },
})

/** An edit Codex made as a patch to one file. */
const patched: CodexRow = {
  method: 'item/started',
  event: 'tool.started',
  params: {
    threadId: THREAD,
    item: {
      type: 'fileChange',
      id: 'call-edit',
      status: 'inProgress',
      changes: [
        {
          path: 'src/notes.md',
          kind: { type: 'update', move_path: null },
          diff: '@@ -1 +1 @@\n-old line\n+new line\n',
        },
      ],
    },
  },
}

/** A turn with a command Codex wrapped in its shell, then an edit given as a patch. */
export const CODEX_ROWS: readonly CodexRow[] = [
  turnStarted,
  said('m1', 'Reading the notes first.'),
  commandStarted('call-sed', `/usr/bin/zsh -lc "sed -n '1,20p' notes.md"`),
  said('m2', 'Now the edit.'),
  patched,
  said('m3', 'Done.'),
  turnEnded('completed'),
]
