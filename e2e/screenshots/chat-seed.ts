import type { TaskInput } from '@seti/shared'
import { Transcript, type Row } from '../../server/src/demo/content/transcript.js'
import { EVENT_COLUMNS, storedColumns } from '../../server/src/events/columns.js'
import { openSeedDb } from '../tests/support/db.js'
import { NOW } from './clock.js'

/** Four agents shaped like a working day, for comparing the chat prototypes. */
export const CHAT_AGENTS = {
  gateway: '7a1c0d11-1111-4a11-8a11-111111111101',
  rollout: '7a1c0d22-2222-4a22-8a22-222222222202',
  flaky: '7a1c0d33-3333-4a33-8a33-333333333303',
  guide: '7a1c0d44-4444-4a44-8a44-444444444404',
} as const

export const GATEWAY_PR = 'https://github.com/acme/api/pull/512'
export const ROLLOUT_COMMAND = 'kubectl -n staging rollout restart deployment/queue-worker'

const REPOS = {
  'acme/api': '9a000000-0000-4000-8000-000000000001',
  'acme/infra': '9a000000-0000-4000-8000-000000000002',
  'acme/docs': '9a000000-0000-4000-8000-000000000003',
} as const

type Repo = keyof typeof REPOS

const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString()

/** Rows of one stretch, spread evenly between `from` and `to` minutes ago. */
interface Stretch {
  rows: Row[]
  from: number
  to: number
}

interface ChatAgent {
  id: string
  title: string
  repo: Repo
  status: 'idle' | 'running'
  stretches: Stretch[]
  extra: Record<string, string | boolean>
}

let failures = 0

/** A shell call whose command exits non-zero, as Claude Code reports it. */
function failedBash(t: Transcript, command: string, output: string, description: string): Transcript {
  failures += 1
  const id = `toolu_fail_${String(failures)}`
  const message = {
    id: `fail-${String(failures)}`,
    type: 'message',
    role: 'assistant',
    model: 'claude-opus',
    content: [{ type: 'tool_use', id, name: 'Bash', input: { command, description } }],
  }
  t.rows.push([
    'sdk',
    { session_id: 's', uuid: `fail-a-${String(failures)}`, type: 'assistant', parent_tool_use_id: null, message },
  ])
  t.rows.push([
    'sdk',
    {
      session_id: 's',
      uuid: `fail-r-${String(failures)}`,
      type: 'user',
      parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: output, is_error: true }] },
    },
  ])
  return t
}

const input = (payload: TaskInput): Row => ['input', payload]

const pr = (
  kind: 'ci_failed' | 'closed' | 'comment' | 'merged' | 'review',
  subject: string,
  title: string,
  body: string,
) => input({ source: 'pr', kind, subject, title, body, url: `https://github.com/${subject.replace('#', '/pull/')}` })

const GATEWAY_DIFF = `\`\`\`diff
-  await sleep(backoff(attempt))
-  const socket = await connect(url)
+  const socket = await connect(url, { resume: session.token })
+  if (socket.resumed) {
+    session.replay(socket.lastAck)
+  }
\`\`\``

function gateway(): ChatAgent {
  const first = new Transcript('gateway')
    .prompt(
      'Reconnects take 4 to 6 seconds after a network blip. Get them under one second, keep the session state, and open a PR.',
    )
    .say('Starting with the reconnect path in the gateway and its tests.')
    .tool('Read', { file_path: 'src/gateway/reconnect.ts' }, 'export async function reconnect(session: Session) {...}')
    .tool('Grep', { pattern: 'backoff\\(', path: 'src' }, 'src/gateway/reconnect.ts\nsrc/gateway/backoff.ts')
    .tool('Read', { file_path: 'src/gateway/session.ts' }, 'export class Session {...}')
    .bash(
      'pnpm vitest run test/reconnect.test.ts',
      ' \u2713 test/reconnect.test.ts (18 tests) 5.2s',
      'Run the reconnect tests',
    )
    .tool(
      'Edit',
      {
        file_path: 'src/gateway/reconnect.ts',
        old_string: 'await sleep(backoff(attempt))',
        new_string: 'const socket = await connect(url, { resume })',
      },
      'The file src/gateway/reconnect.ts has been updated.',
    )
    .tool(
      'Edit',
      { file_path: 'src/gateway/session.ts', old_string: 'replay()', new_string: 'replay(lastAck)' },
      'The file src/gateway/session.ts has been updated.',
    )
  failedBash(
    first,
    'pnpm vitest run test/reconnect.test.ts',
    ' \u276f test/reconnect.test.ts (18 tests | 1 failed) 1.1s\n   \u00d7 keeps pending acks across a resume\n     AssertionError: expected [] to deeply equal [ 41, 42 ]\n\n Test Files  1 failed (1)\n      Tests  1 failed | 17 passed (18)',
    'Run the reconnect tests',
  )
  first
    .say('One test fails: a resumed session drops the acks still in flight. Replaying them before new frames.')
    .tool(
      'Edit',
      {
        file_path: 'src/gateway/session.ts',
        old_string: 'this.pending = []',
        new_string: 'this.pending = this.pending.filter(after(lastAck))',
      },
      'The file src/gateway/session.ts has been updated.',
    )
    .bash(
      'pnpm vitest run test/reconnect.test.ts',
      ' \u2713 test/reconnect.test.ts (18 tests) 0.9s',
      'Run the reconnect tests',
    )
    .bash('pnpm tsc --noEmit', '', 'Typecheck')
    .bash(
      'git commit -am "fix(gateway): resume sessions instead of reconnecting from scratch"',
      '[fix/fast-reconnect 4be21c0] fix(gateway): resume sessions',
      'Commit',
    )
    .bash('gh pr create --fill', GATEWAY_PR, 'Open the pull request')
    .say(
      `Reconnects now resume the session instead of starting over: p95 went from 4.8 s to 380 ms in the reconnect bench, and pending acks survive.\n\n${GATEWAY_DIFF}\n\nI opened **acme/api#512**.`,
    )
    .ended(312_000, 1.84)
  const second = new Transcript('gateway2')
  second.rows.push(
    pr(
      'review',
      'acme/api#512',
      'lee requested changes on acme/api#512',
      '**lee** requested changes: cap the replay buffer, a long outage could replay thousands of frames.',
    ),
  )
  second.rows.push(['prompt', { text: '', auto: true, inputs: 1 }])
  second
    .tool(
      'Edit',
      {
        file_path: 'src/gateway/session.ts',
        old_string: 'this.pending.filter',
        new_string: 'cap(this.pending, MAX_REPLAY)',
      },
      'The file src/gateway/session.ts has been updated.',
    )
    .bash(
      'pnpm vitest run test/reconnect.test.ts',
      ' \u2713 test/reconnect.test.ts (19 tests) 1.0s',
      'Run the reconnect tests',
    )
    .bash(
      'git push',
      'To github.com:acme/api.git\n   4be21c0..7d02e9a  fix/fast-reconnect -> fix/fast-reconnect',
      'Push',
    )
    .say(
      'Capped the replay buffer at 500 frames, with a test for a long outage, and pushed. Replied on the review thread.',
    )
    .ended(96_000, 0.42)
  const third = new Transcript('gateway3')
    .prompt('Good. Run the soak test against staging before we merge, and tell me the drop rate.')
    .say('Deploying the branch to staging and starting a 10 minute soak.')
    .bash(
      'pnpm deploy:staging --branch fix/fast-reconnect',
      'Deployed api@7d02e9a to staging',
      'Deploy the branch to staging',
    )
    .bash('pnpm soak --target staging --minutes 10 --blips 30', null, 'Soak test against staging')
  third.rows.push(
    pr('closed', 'acme/api#498', 'acme/api#498 was closed without merging', 'Closed by **lee**: superseded by #512.'),
  )
  third.rows.push(
    pr(
      'ci_failed',
      'acme/api#512',
      'CI failed on acme/api#512',
      'Failing checks on 7d02e9a:\n- e2e (chromium) (failure)',
    ),
  )
  third.rows.push(
    pr(
      'comment',
      'acme/api#512',
      'nina commented on acme/api#512',
      '**nina** commented: does this change the reconnect metric names? The dashboard reads them.',
    ),
  )
  return {
    id: CHAT_AGENTS.gateway,
    title: 'Cut reconnect latency in the media gateway',
    repo: 'acme/api',
    status: 'running',
    stretches: [
      { rows: first.rows, from: 46, to: 31 },
      { rows: second.rows, from: 24, to: 20 },
      { rows: third.rows.slice(0, 5), from: 9, to: 6 },
      { rows: third.rows.slice(5), from: 4, to: 1 },
    ],
    extra: { color: '#5488ec' },
  }
}

function rollout(): ChatAgent {
  const t = new Transcript('rollout')
    .prompt('Roll the new queue worker image out to staging and watch the backlog drain.')
    .bash(
      'kubectl -n staging get deployment queue-worker -o wide',
      'NAME           READY   UP-TO-DATE   AVAILABLE   AGE\nqueue-worker   3/3     3            3           12d',
      'Check the deployment',
    )
    .tool(
      'Edit',
      {
        file_path: 'k8s/staging/queue-worker.yaml',
        old_string: 'image: queue-worker:2.3.1',
        new_string: 'image: queue-worker:2.4.0',
      },
      'The file k8s/staging/queue-worker.yaml has been updated.',
    )
    .bash(
      'kubectl -n staging apply -f k8s/staging/queue-worker.yaml',
      'deployment.apps/queue-worker configured',
      'Apply the new image',
    )
    .say('The image is set to 2.4.0. Restarting the deployment so the pods pick it up; the backlog is 1,240 jobs now.')
    .tool('Bash', { command: ROLLOUT_COMMAND, description: 'Restart the queue worker' }, null)
  return {
    id: CHAT_AGENTS.rollout,
    title: 'Roll out the queue worker to staging',
    repo: 'acme/infra',
    status: 'running',
    stretches: [{ rows: t.rows, from: 7, to: 1 }],
    extra: { color: '#e77f3e', blocked: `Asks to use Bash: ${ROLLOUT_COMMAND}` },
  }
}

const FLAKY_QUESTION =
  'The upload retry test flakes because the fake server answers before the retry timer starts, so the second attempt sometimes never happens.\n\nTwo fixes work:\n\n1. Use fake timers in the test. Small, and only the test changes.\n2. Start the timer before the request. Fixes a real race in the client too, and touches 2 files.\n\nWhich do you want?'

function flaky(): ChatAgent {
  const t = new Transcript('flaky')
    .prompt('upload-retry.test.ts fails about one run in eight on CI. Find out why.')
    .bash(
      'pnpm vitest run test/upload-retry.test.ts --repeat=40',
      ' 35 passed\n 5 failed\n   \u00d7 retries a failed chunk once\n     expected 2 calls, received 1',
      'Repeat the test 40 times',
    )
    .tool('Grep', { pattern: 'retryTimer', path: 'src/upload' }, 'src/upload/client.ts')
    .tool('Read', { file_path: 'src/upload/client.ts' }, 'export async function sendChunk(chunk: Chunk) {...}')
    .say(FLAKY_QUESTION)
    .ended(126_000, 0.38)
  return {
    id: CHAT_AGENTS.flaky,
    title: 'Fix the flaky upload retry test',
    repo: 'acme/api',
    status: 'idle',
    stretches: [{ rows: t.rows, from: 14, to: 5 }],
    extra: { color: '#b066da', asking: true, unseen: true },
  }
}

function guide(): ChatAgent {
  const t = new Transcript('guide')
    .prompt('Write a migration guide for webhooks v2 for our partners, and open a PR in the docs repo.')
    .tool('Read', { file_path: 'openapi/webhooks-v2.yaml' }, 'openapi: 3.1.0 ...')
    .tool('Write', { file_path: 'docs/webhooks-v2.md', content: '# Webhooks v2' }, 'File created.')
    .bash('pnpm docs:lint docs/webhooks-v2.md', 'No problems found.', 'Lint the guide')
    .bash('gh pr create --fill', 'https://github.com/acme/docs/pull/77', 'Open the pull request')
    .say(
      'The guide is in `docs/webhooks-v2.md`: what changes, the new signature header, and a retry table. **acme/docs#77** is open for review.',
    )
    .ended(148_000, 0.51)
  const later: Row[] = [pr('merged', 'acme/docs#77', 'acme/docs#77 was merged', 'Merged by **nina** into main.')]
  const mention = input({
    source: 'team',
    kind: 'mention',
    message_id: 4101,
    subject: 'api',
    title: 'Group chat, from api',
    body: '@guide the retry header is `Retry-After-Ms` now, not `Retry-After`. Can you fix that in the guide?',
    url: null,
  })
  const slack = input({
    source: 'channel',
    kind: 'message',
    channel: 'Slack #partner-api',
    channel_id: 'c-slack-partner',
    event_id: 9001,
    severity: 'info',
    received_at: ago(8),
    subject: 'Maya',
    title: 'Maya replied in #partner-api',
    body: 'Partners keep asking whether v1 webhooks still work after June. Could the guide say that in its first paragraph?',
    url: null,
  })
  return {
    id: CHAT_AGENTS.guide,
    title: 'Write the webhooks v2 guide',
    repo: 'acme/docs',
    status: 'idle',
    stretches: [
      { rows: t.rows, from: 66, to: 60 },
      { rows: later, from: 45, to: 45 },
      { rows: [mention], from: 21, to: 21 },
      { rows: [slack], from: 8, to: 8 },
    ],
    extra: { color: '#4eb068', input_mode: 'queue' },
  }
}

type Run = (query: string, ...values: (string | number | null)[]) => Promise<void>

async function seedRows(run: Run, agent: ChatAgent): Promise<void> {
  for (const { rows, from, to } of agent.stretches) {
    const step = (from - to) / Math.max(1, rows.length - 1)
    for (const [n, [kind, payload]] of rows.entries()) {
      const json = JSON.stringify(payload)
      const columns = storedColumns(kind, json, null)
      const values = EVENT_COLUMNS.map((column) => {
        const value = columns[column]
        return typeof value === 'boolean' ? String(value) : (value ?? null)
      })
      await run(
        `INSERT INTO task_message (task_id, kind, payload, outward, created_at, ${EVENT_COLUMNS.join(', ')})
         VALUES (?, ?, ?, '[]', ?, ${EVENT_COLUMNS.map(() => '?').join(', ')})`,
        agent.id,
        kind,
        json,
        ago(from - n * step),
        ...values,
      )
    }
  }
}

async function seedAgent(run: Run, agent: ChatAgent): Promise<void> {
  const first = agent.stretches[0]?.from ?? 0
  const last = agent.stretches.at(-1)?.to ?? 0
  await run(
    `INSERT INTO task (id, title, repo_id, cwd, worktree, status, sandbox, session_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, ?, 1, ?, ?, ?)`,
    agent.id,
    agent.title,
    REPOS[agent.repo],
    `/srv/${agent.repo}`,
    agent.status,
    `session-${agent.id.slice(0, 8)}`,
    ago(first),
    ago(last),
  )
  await seedRows(run, agent)
  for (const [column, value] of Object.entries(agent.extra)) {
    if (typeof value === 'boolean') {
      await run(`UPDATE task SET ${column} = ${String(value)} WHERE id = ?`, agent.id)
    } else {
      await run(`UPDATE task SET ${column} = ? WHERE id = ?`, value, agent.id)
    }
  }
}

export async function seedChatAgents(): Promise<void> {
  const db = openSeedDb()
  for (const [n, [slug, id]] of Object.entries(REPOS).entries()) {
    await db.run(
      `INSERT INTO repo (id, slug, path, base_branch, created_at) VALUES (?, ?, ?, 'main', ?)`,
      id,
      slug,
      `/srv/${slug}`,
      ago(60 * 24 * 30 - n),
    )
  }
  for (const agent of [gateway(), rollout(), flaky(), guide()]) {
    await seedAgent(db.run, agent)
  }
  await db.run(
    `INSERT INTO task_pr (task_id, pr_url, linked_at, source) VALUES (?, ?, ?, 'agent')`,
    CHAT_AGENTS.gateway,
    GATEWAY_PR,
    ago(30),
  )
  await db.close()
}
