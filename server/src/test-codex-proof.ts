import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { answerQuestionsInput, CODEX_SETTINGS_DEFAULTS, DEFAULT_PROFILE_ID, type Task } from '@seti/shared'
import { findBinary } from './binaries.js'
import { copyState, installCodex } from './codex-install.js'
import { CODEX_PIN } from './codex-pin.js'
import { sql, tasks } from './db.js'
import { connectNode } from './node-split.js'
import { answerPermission } from './permission-rules.js'
import { answerQuestions } from './question-answers.js'
import type { Step } from './runtimes/conformance/script.js'
import { runTurn, stopTurn } from './session-control.js'
import { isRunning } from './session-mirror.js'
import { restartSession } from './session-restart.js'
import { codexSettings } from './store/codex-settings.js'
import { permissionRequests } from './store/permissions.js'
import { questions } from './store/questions.js'
import { routeEgressForTests } from './task-proxy.js'
import { TestModelHost } from './test-codex-model.js'
import { fakeBuild, FakeRegistry } from './test-codex-registry.js'
import { MODEL_HOST } from './test-codex-upstream.js'
import { keyConnection } from './test-connections.js'

/** Whether this host runs Seti's sandbox: bwrap with user namespaces, and socat. */
export function canSandbox(): boolean {
  try {
    findBinary('socat')
    execFileSync(findBinary('bwrap'), ['--unshare-user', '--unshare-net', '--ro-bind', '/', '/', 'true'])
    return true
  } catch {
    return false
  }
}

const POLL_MS = 200
const TURN_MS = 90_000

const pause = async (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

/** The first turn: a command, an edit, a question, Seti's tools in and above the level, a denial. */
function firstTurn(task: Task, binary: string): Step[] {
  const locked = [
    'echo x >> "$CODEX_HOME/config.toml"; echo $?',
    `touch ${path.dirname(binary)}/seti-proof; echo $?`,
  ].join('; ')
  return [
    { call: { tool: 'sh', args: { cmd: 'env > env.txt' } } },
    { call: { tool: 'add', args: { path: 'notes.txt', line: 'from codex' } } },
    { call: { tool: 'ask', args: { questions: [{ text: 'Which colour?', options: ['Blue', 'Red'] }] } } },
    { call: { tool: 'seti.get_task', args: { task: task.id } } },
    { call: { tool: 'seti.list_tasks', args: {} } },
    { call: { tool: 'sh', args: { cmd: 'rm keep.txt' } } },
    { call: { tool: 'sh', args: { cmd: `{ ${locked}; } > locked.txt 2>/dev/null` } } },
    { say: 'done' },
  ]
}

/**
 * Answers what the agent asks as a user would: allows every call but an `rm`, picks Blue.
 * Before it allows `list_tasks`, the user lowers the agent's Seti control to Self, which that
 * tool exceeds.
 */
async function answerWaits(task: Task): Promise<void> {
  for (const request of await permissionRequests.pending(task.id)) {
    if (request.tool_name.includes('list_tasks')) {
      await sql`UPDATE task SET seti_level = 'self' WHERE id = ${task.id}`
    }
    const decision = request.summary.startsWith('rm ') ? 'deny' : 'allow'
    await answerPermission(task, request.id, { decision })
  }
  const open = await questions.openList(task.id)
  if (open.length > 0) {
    const items = open.map((question) => ({ action: 'answer', id: question.id, selected: ['Blue'] }))
    await answerQuestions(answerQuestionsInput.parse({ items }))
  }
}

const where = async (task: Task, model: TestModelHost) => {
  const rows = await sql<{ kind: string; payload: string }[]>`SELECT kind, payload::text AS payload FROM task_message
    WHERE task_id = ${task.id} ORDER BY id DESC LIMIT 6`
  const asks = (await permissionRequests.pending(task.id)).map((r) => `${r.tool_name}:${r.summary}`)
  const bodies = model.fake.bodies.length
  return JSON.stringify({ asks, bodies, rows: rows.map((r) => `${r.kind} ${r.payload.slice(0, 300)}`) })
}

/** Answers the agent's waits until its turn ends. */
async function untilIdle(task: Task, model?: TestModelHost): Promise<void> {
  const deadline = Date.now() + TURN_MS
  await pause(POLL_MS)
  while (isRunning(task.id)) {
    if (Date.now() > deadline) {
      throw new Error(`The Codex turn did not end ${model === undefined ? '' : await where(task, model)}`)
    }
    await answerWaits(task)
    await pause(POLL_MS)
  }
}

/** A split node in a process of its own whose proxies reach the model host, once it listens. */
async function startNode(model: TestModelHost, notes: string): Promise<ChildProcess> {
  const entry = path.join(import.meta.dirname, 'test-codex-node.ts')
  const args = ['--import', 'tsx', entry, String(model.port), model.caFile, notes]
  const child = spawn(process.execPath, args, {
    cwd: path.dirname(import.meta.dirname),
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  await new Promise<void>((resolve, reject) => {
    child.stdout.on('data', (chunk: Buffer) => {
      if (chunk.toString('utf8').includes('seti node listening')) {
        resolve()
      }
    })
    child.once('exit', (code) => {
      reject(new Error(`The split node exited with ${String(code)}`))
    })
  })
  await connectNode()
  return child
}

/** Installs the pinned Codex into Seti's own folder from a registry here, as turning it on does. */
async function installFrom(scratch: string, binary: string): Promise<string> {
  const registry = await new FakeRegistry().start()
  try {
    await installCodex('user', registry.pin(fakeBuild(scratch, CODEX_PIN.version, binary)))
  } finally {
    await registry.close()
  }
  const copy = await copyState()
  if (copy.state !== 'ready') {
    throw new Error(`The pinned Codex did not install from ${binary}: ${JSON.stringify(copy)}`)
  }
  return copy.program
}

/**
 * One proof run: the model host, Codex on with the pinned program, and a key the proxy adds.
 * With `split`, sessions and proxies run in a node process of their own, as `SETI_NODE=split`
 * runs them.
 */
export async function proofRun(scratch: string, binary: string, split: boolean) {
  const model = new TestModelHost()
  const local = await model.start(scratch)
  const notes = path.join(scratch, 'egress-notes')
  const node = split ? await startNode(model, notes) : null
  if (node === null) {
    routeEgressForTests(local)
  }
  await codexSettings.set({ ...CODEX_SETTINGS_DEFAULTS, enabled: true })
  const program = await installFrom(scratch, binary)
  const key = `proof-${randomUUID()}`
  await keyConnection('proof_openai', key, {
    hosts: [MODEL_HOST],
    header: { name: 'Authorization', template: 'Bearer {{value}}' },
    profile_ids: [DEFAULT_PROFILE_ID],
  })
  return {
    model,
    key,
    /** Seti's own copy of the pinned Codex, which the agent runs. */
    program,
    /** A Codex agent at Full Seti control in a folder of its own, with a file it is told to remove. */
    agent: async (): Promise<Task> => {
      const id = randomUUID()
      const cwd = fs.mkdtempSync(path.join(scratch, 'agent-'))
      fs.writeFileSync(path.join(cwd, 'keep.txt'), 'keep\n')
      await tasks.insert({ id, title: `Proof ${id.slice(0, 8)}`, repo_id: null, cwd, worktree: false, pr_urls: [] })
      await sql`UPDATE task SET runtime = 'codex', requested_model = 'gpt-5.5', seti_level = 'full' WHERE id = ${id}`
      const task = await tasks.get(id)
      if (task === undefined) {
        throw new Error('The proof agent was not stored')
      }
      return task
    },
    firstTurn: async (task: Task) => {
      model.play([firstTurn(task, program), [{ hold: true }], [{ recall: true }]])
      await runTurn(task.id, 'go')
      await untilIdle(task, model)
    },
    interruptedTurn: async (task: Task) => {
      await runTurn(task.id, 'wait')
      await pause(1000)
      await stopTurn(task.id)
      await untilIdle(task)
    },
    restartAndResume: async (task: Task) => {
      await restartSession(task, { interrupt: false })
      await runTurn(task.id, 'again')
      await untilIdle(task)
    },
    /** Takes in what a split node noted of its proxies' hosts. */
    egressNoted: () => {
      if (fs.existsSync(notes)) {
        for (const line of fs.readFileSync(notes, 'utf8').trim().split('\n')) {
          const [kind, host = ''] = line.split(' ')
          model.note(kind === 'dialled' ? 'dialled' : 'refused', host)
        }
        fs.rmSync(notes)
      }
    },
    close: async () => {
      routeEgressForTests(null)
      node?.kill()
      model.close()
      return Promise.resolve()
    },
  }
}

export type ProofRun = Awaited<ReturnType<typeof proofRun>>
