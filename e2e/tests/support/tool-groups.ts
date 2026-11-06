import { randomUUID } from 'node:crypto'
import { openSeedDb } from './db.js'
import { paths } from './env.js'

const SESSION = 'burst-session'

const HEREDOC_BODY = Array.from({ length: 60 }, (_, n) => `  line-${String(n)}: value-${String(n)}`).join('\n')

/** A Bash call in the seeded burst; `error` makes its result fail with that exit code. */
interface BurstCall {
  input: Record<string, unknown>
  output: string
  error?: number
  outward?: boolean
  name?: string
}

/** The narration and calls of the seeded burst, in transcript order. */
export const BURST = {
  intro: 'Checking the cluster before the rollout.',
  first: [
    { input: { command: 'kubectl get pods -n acme-app', description: 'List app pods' }, output: 'pod-a Running' },
    { input: { command: 'cd /srv/devops && git status --short' }, output: ' M deploy.yaml' },
    {
      input: { command: `cat > /tmp/values.yaml <<'EOF'\n${HEREDOC_BODY}\nEOF\nhelm lint /tmp/values.yaml` },
      output: 'linted',
    },
    {
      input: { command: 'IMAGE_TAG=v42 REGION=us-east-1 ./scripts/push-image.sh --tag "$IMAGE_TAG"' },
      output: 'pushed v42',
      outward: true,
    },
    { input: { command: 'npm run verify -- --strict' }, output: 'Exit code 2\nverify failed: 3 errors', error: 2 },
    { input: { command: 'git diff --stat', description: 'Show the staged diff' }, output: '1 file changed' },
    { input: { command: 'git log --oneline -3' }, output: 'abc fix\ndef feat\n123 chore' },
    { input: { command: 'kubectl rollout history deploy/voice-agent -n acme-app' }, output: 'REVISION 7 quasarline' },
    { input: { command: 'kubectl describe deploy/voice-agent -n acme-app | head -40' }, output: 'Name: voice-agent' },
    {
      input: { command: 'gh pr view 181 --json state,mergeable', description: 'Check the PR state' },
      output: '{"state":"OPEN"}',
    },
  ] satisfies BurstCall[],
  middle: 'Image is pushed; now bump the tag.',
  second: [
    { input: { command: 'sed -i "s/v41/v42/" deploy.yaml' }, output: '' },
    { input: { file_path: '/srv/devops/deploy.yaml' }, output: 'image: v42', name: 'Read' },
    { input: { file_path: '/srv/devops/kustomization.yaml' }, output: 'resources: []', name: 'Read' },
  ] satisfies BurstCall[],
  monitor: { command: 'kubectl rollout status deploy/voice-agent -w', description: 'Watch the voice-agent rollout' },
  outro: 'The rollout is under way; I will report when it settles.',
} as const

/** A word in the output of the eighth call, hidden while its group is collapsed. */
export const BURST_NEEDLE = 'quasarline'

const assistant = (content: unknown[]) => ({
  type: 'assistant',
  message: { id: randomUUID(), type: 'message', role: 'assistant', model: 'claude', content },
  parent_tool_use_id: null,
  session_id: SESSION,
  uuid: randomUUID(),
})

const toolResult = (toolUseId: string, content: string, isError: boolean) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }] },
  parent_tool_use_id: null,
  session_id: SESSION,
  uuid: randomUUID(),
})

const progress = (toolUseId: string) => ({
  type: 'system',
  subtype: 'task_progress',
  task_id: 'bg',
  tool_use_id: toolUseId,
  description: 'progress',
  usage: { total_tokens: 1200, tool_uses: 1, duration_ms: 1700 },
  session_id: SESSION,
  uuid: randomUUID(),
})

interface Row {
  kind: string
  payload: unknown
  outward: string[]
}

function callRows(calls: readonly BurstCall[], prefix: string): Row[] {
  return calls.flatMap((call, n) => {
    const id = `toolu_${prefix}_${String(n)}`
    const use = { type: 'tool_use', id, name: call.name ?? 'Bash', input: call.input }
    return [
      { kind: 'sdk', payload: assistant([{ type: 'thinking', thinking: 'hm', signature: '' }]), outward: [] },
      { kind: 'sdk', payload: assistant([use]), outward: call.outward === true ? [id] : [] },
      { kind: 'sdk', payload: progress(id), outward: [] },
      { kind: 'sdk', payload: toolResult(id, call.output, call.error !== undefined), outward: [] },
    ]
  })
}

/** An idle agent whose transcript is a burst of commands between short narration. */
export async function seedToolBurst(title: string): Promise<string> {
  const db = openSeedDb()
  const id = randomUUID()
  const start = Date.now() - 10 * 60_000
  await db.idleTask(id, title, paths.checkout, new Date(start).toISOString())
  const monitorId = 'toolu_burst_monitor'
  const rows: Row[] = [
    { kind: 'prompt', payload: { text: 'Ship the deploy fix and watch the rollout.' }, outward: [] },
    { kind: 'sdk', payload: assistant([{ type: 'text', text: BURST.intro }]), outward: [] },
    ...callRows(BURST.first, 'first'),
    { kind: 'sdk', payload: assistant([{ type: 'text', text: BURST.middle }]), outward: [] },
    ...callRows(BURST.second, 'second'),
    {
      kind: 'sdk',
      payload: assistant([{ type: 'tool_use', id: monitorId, name: 'Monitor', input: BURST.monitor }]),
      outward: [],
    },
    {
      kind: 'sdk',
      payload: {
        type: 'system',
        subtype: 'task_started',
        task_id: 'bmonitor1',
        tool_use_id: monitorId,
        description: BURST.monitor.description,
        is_backgrounded: true,
        task_type: 'local_bash',
        session_id: SESSION,
        uuid: randomUUID(),
      },
      outward: [],
    },
    { kind: 'sdk', payload: toolResult(monitorId, 'Monitor started (task bmonitor1).', false), outward: [] },
    { kind: 'sdk', payload: assistant([{ type: 'text', text: BURST.outro }]), outward: [] },
  ]
  await insertRows(db, id, start, rows)
  await db.close()
  return id
}

/** One group of every common kind, whose label runs far wider than a narrow card. */
export const MIXED = {
  label: 'Updated the todo list, ran 10 commands, ran 1 search, made 3 MCP calls, used 1 tool',
  outro: 'Every kind of call is in.',
  calls: [
    { input: { subject: 'Ship the fix', description: 'Ship it' }, output: 'Task #1 created', name: 'TaskCreate' },
    ...Array.from({ length: 10 }, (_, n) => ({ input: { command: `make step-${String(n)}` }, output: 'ok' })),
    { input: { pattern: 'overflow', path: 'ui/src' }, output: 'ui/src/a.tsx', name: 'Grep' },
    ...Array.from({ length: 3 }, (_, n) => ({
      input: { task_id: String(n) },
      output: '{}',
      name: 'mcp__clickup__clickup_get_bulk_tasks_time_in_status',
    })),
    { input: { operation: 'hover' }, output: 'done', name: 'LSP' },
  ] satisfies BurstCall[],
} as const

/** An idle agent whose transcript is one group mixing every common kind of call. */
export async function seedMixedGroup(title: string): Promise<string> {
  const db = openSeedDb()
  const id = randomUUID()
  const start = Date.now() - 10 * 60_000
  await db.idleTask(id, title, paths.checkout, new Date(start).toISOString())
  await insertRows(db, id, start, [
    { kind: 'prompt', payload: { text: 'Use every tool you have.' }, outward: [] },
    ...callRows(MIXED.calls, 'mixed'),
    { kind: 'sdk', payload: assistant([{ type: 'text', text: MIXED.outro }]), outward: [] },
  ])
  await db.close()
  return id
}

async function insertRows(db: ReturnType<typeof openSeedDb>, id: string, start: number, rows: readonly Row[]) {
  let at = start
  for (const row of rows) {
    at += 1700
    await db.run(
      `INSERT INTO task_message (task_id, kind, payload, outward, created_at) VALUES (?, ?, ?, ?, ?)`,
      id,
      row.kind,
      JSON.stringify(row.payload),
      JSON.stringify(row.outward),
      new Date(at).toISOString(),
    )
  }
}
