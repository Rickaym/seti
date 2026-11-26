import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_PROFILE_ID, GEMINI_SETTINGS_DEFAULTS, type Task } from '@seti/shared'
import { findBinary } from './binaries.js'
import { CLAUDE_HOME, GEMINI_ROOT, SETI_HOME } from './config.js'
import { sql, tasks } from './db.js'
import { versionDir } from './gemini-fetch.js'
import { GEMINI_PIN } from './gemini-pin.js'
import { answerPermission } from './permission-rules.js'
import type { Step } from './runtimes/conformance/script.js'
import { ScriptedGemini } from './runtimes/gemini/conformance-api.js'
import { geminiCall } from './runtimes/gemini/conformance-rig.js'
import { runTurn } from './session-control.js'
import { isRunning } from './session-mirror.js'
import { geminiSettings } from './store/gemini-settings.js'
import { permissionRequests } from './store/permissions.js'
import { routeEgressForTests } from './task-proxy.js'
import { TestModelHost } from './test-codex-model.js'
import { keyConnection } from './test-connections.js'

/** Google's Gemini API host, the only host a Gemini agent's proxy may reach. */
export const GEMINI_HOST = 'generativelanguage.googleapis.com'

const POLL_MS = 200
const TURN_MS = 120_000

const pause = async (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

/** A secret value the agent must never read, distinct per place it lies. */
const secret = (where: string) => `PROOF_SECRET_${where}_${randomUUID().replaceAll('-', '')}`

/**
 * Secrets outside the agent's folders: beside its folder, in Seti's and Claude's homes, and in
 * the environment of a host process that is not the agent's.
 */
function plantSecrets(scratch: string) {
  const values = {
    beside: secret('beside'),
    setiHome: secret('seti'),
    claudeHome: secret('claude'),
    environ: secret('environ'),
  }
  const outside = path.join(scratch, 'outside')
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(outside, 'secret.txt'), `${values.beside}\n`)
  fs.mkdirSync(SETI_HOME, { recursive: true })
  fs.writeFileSync(path.join(SETI_HOME, 'proof-secret.txt'), `${values.setiHome}\n`)
  fs.mkdirSync(CLAUDE_HOME, { recursive: true })
  fs.writeFileSync(path.join(CLAUDE_HOME, 'proof-secret.txt'), `${values.claudeHome}\n`)
  const holder = spawn(findBinary('sleep'), ['600'], { env: { SETI_PROOF_SECRET: values.environ }, stdio: 'ignore' })
  if (holder.pid === undefined) {
    throw new Error('The process holding the environment secret did not start')
  }
  return { values, outside, holder, holderPid: holder.pid }
}

/** The agent's folder: a file of its own and links a hostile repository could carry out of it. */
function agentFolder(scratch: string, outside: string, holderPid: number): string {
  const cwd = fs.mkdtempSync(path.join(scratch, 'agent-'))
  fs.writeFileSync(path.join(cwd, 'inside.txt'), 'PROOF_INSIDE\n')
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(cwd, 'link.txt'))
  fs.symlinkSync('../outside/secret.txt', path.join(cwd, 'rel-link.txt'))
  fs.symlinkSync(outside, path.join(cwd, 'outdir'))
  fs.symlinkSync(SETI_HOME, path.join(cwd, 'seti-home'))
  fs.symlinkSync(`/proc/${String(holderPid)}/environ`, path.join(cwd, 'host-environ'))
  return cwd
}

/** Every read the proof tries, as shell commands; the first is the control inside the folder. */
export function proofCommands(holderPid: number): string[] {
  return [
    'cat inside.txt',
    'cat link.txt',
    'cat rel-link.txt',
    'cat outdir/secret.txt',
    'ls -la outdir',
    'cat seti-home/proof-secret.txt',
    'cat host-environ',
    'cat ../outside/secret.txt',
    'ls -la ..',
    'grep -r PROOF_SECRET ..',
    'grep -ac PROOF_SECRET /proc/self/environ /proc/1/environ',
    `cat /proc/${String(holderPid)}/environ`,
    `cat ${path.join(SETI_HOME, 'proof-secret.txt')}`,
    `cat ${path.join(CLAUDE_HOME, 'proof-secret.txt')}`,
    `ls -la ${os.homedir()}`,
  ]
}

/** The same reads through Gemini CLI's own file tools, which never ask. */
const TOOL_READS: Step[] = [
  { call: { tool: 'cat', args: { path: 'link.txt' } } },
  { call: { tool: 'cat', args: { path: 'outdir/secret.txt' } } },
  { call: { tool: 'cat', args: { path: '../outside/secret.txt' } } },
  { call: { tool: 'grep', args: { pattern: 'PROOF_SECRET' } } },
]

/** Allows every call the agent asks about, so only the sandbox stands between it and a secret. */
async function allowAll(task: Task, asked: string[]): Promise<void> {
  for (const request of await permissionRequests.pending(task.id)) {
    asked.push(request.summary)
    await answerPermission(task, request.id, { decision: 'allow' })
  }
}

/** Installs the pinned bundle the test names into Seti's own folder, as turning Gemini on does. */
function installFrom(entry: string): void {
  const version = path.dirname(path.dirname(entry))
  fs.cpSync(version, versionDir(GEMINI_ROOT, GEMINI_PIN.version), { recursive: true })
}

/** One proof run: the Gemini API host, Gemini on with the pinned bundle, and a key the proxy adds. */
export async function geminiProofRun(scratch: string, entry: string) {
  const model = new TestModelHost(new ScriptedGemini(geminiCall), GEMINI_HOST, 'x-goog-api-key')
  routeEgressForTests(await model.start(scratch))
  await geminiSettings.set({ ...GEMINI_SETTINGS_DEFAULTS, enabled: true, evaluator_decides: false })
  installFrom(entry)
  const key = `proof-${randomUUID()}`
  await keyConnection('proof_gemini', key, {
    hosts: [GEMINI_HOST],
    header: { name: 'x-goog-api-key', template: '{{value}}' },
    profile_ids: [DEFAULT_PROFILE_ID],
  })
  const { values, outside, holder, holderPid } = plantSecrets(scratch)
  return {
    model,
    key,
    secrets: values,
    commands: proofCommands(holderPid),
    /** A Gemini agent at Full Seti control in a folder of its own. */
    agent: async (): Promise<Task> => {
      const id = randomUUID()
      const cwd = agentFolder(scratch, outside, holderPid)
      await tasks.insert({ id, title: `Proof ${id.slice(0, 8)}`, repo_id: null, cwd, worktree: false, pr_urls: [] })
      await sql`UPDATE task SET runtime = 'gemini', requested_model = 'gemini-3.8-flash', seti_level = 'full'
        WHERE id = ${id}`
      const task = await tasks.get(id)
      if (task === undefined) {
        throw new Error('The proof agent was not stored')
      }
      return task
    },
    /** One turn of every read; returns what the agent asked about and each call's result. */
    reads: async (task: Task) => {
      const shell: Step[] = proofCommands(holderPid).map((cmd) => ({ call: { tool: 'sh', args: { cmd } } }))
      model.play([[...shell, ...TOOL_READS, { say: 'read' }]])
      const asked: string[] = []
      await runTurn(task.id, 'go')
      const deadline = Date.now() + TURN_MS
      await pause(POLL_MS)
      while (isRunning(task.id)) {
        if (Date.now() > deadline) {
          throw new Error(`The Gemini turn did not end; asked so far: ${JSON.stringify(asked)}`)
        }
        await allowAll(task, asked)
        await pause(POLL_MS)
      }
      return { asked, results: [...model.fake.responses] }
    },
    close: () => {
      routeEgressForTests(null)
      model.close()
      holder.kill()
    },
  }
}
