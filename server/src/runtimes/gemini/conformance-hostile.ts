import { copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { RuntimeEvent, ToolCall } from '@seti/shared'
import type { Launcher } from '../../launcher.js'
import { geminiLocks, prepareGemini } from '../../sandbox-gemini.js'
import type { SandboxLayout } from '../../sandbox-mounts.js'
import { acpAdapterFor } from '../acp/adapter.js'
import type { SessionInput } from '../adapter.js'
import { RealProcess, stopAll } from '../conformance/real-process.js'
import { Channel, isTurnEnd, Run } from '../conformance/run.js'
import type { Step } from '../conformance/script.js'
import { ScriptedGemini } from './conformance-api.js'
import { geminiCall } from './conformance-rig.js'
import { geminiLaunch } from './launch.js'

/** The pinned bundle's entry the hostile tests run, or none, which skips them. */
export const HOSTILE_ENTRY = process.env.SETI_GEMINI_BIN ?? ''

const SEARCH_PATH = '/usr/bin:/bin'
const passThrough = { inbound: (line: string) => [line], outbound: (line: string) => ({ lines: [line] }) }

/** One test's folders: a private home, a working folder inside a parent, and Seti's task state. */
export interface Planted {
  home: string
  work: string
  parent: string
  task: string
  claudeHome: string
}

/** A bench of real Gemini CLI processes over a scripted API, in a folder of its own. */
export class HostileBench {
  readonly model = new ScriptedGemini(geminiCall)
  folder = ''
  private baseUrl = ''

  async start(): Promise<void> {
    this.folder = mkdtempSync(path.join(tmpdir(), 'seti-gemini-hostile-'))
    this.baseUrl = await this.model.start()
  }

  close(): void {
    if (this.folder !== '') {
      this.model.close()
      rmSync(this.folder, { recursive: true, force: true })
    }
  }

  /** Folders for one test, with `files` written under it by their path from its root. */
  planted(name: string, files: Record<string, string>): Planted {
    const at = (...parts: string[]) => path.join(this.folder, name, ...parts)
    const where = {
      home: at('home'),
      parent: at('code'),
      work: at('code', 'app'),
      task: at('task'),
      claudeHome: at('claude'),
    }
    for (const dir of Object.values(where)) {
      mkdirSync(dir, { recursive: true })
    }
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(path.dirname(at(file)), { recursive: true })
      writeFileSync(at(file), text)
    }
    prepareGemini(where.task, { cwd: where.work, dirs: [] })
    return where
  }

  /**
   * The home and working folder as Seti's sandbox shows them: each covered file holds its cover's
   * text and each covered folder is empty, the planted one moved out of Gemini CLI's reach.
   */
  covered(where: Planted): void {
    const layout = { home: where.home, taskDir: where.task, claudeHome: where.claudeHome, cwd: where.work, dirs: [] }
    for (const mount of geminiLocks(layout as unknown as SandboxLayout, path.join(this.folder, 'no-etc'))) {
      if (mount.kind !== 'ro-bind' || !mount.dest.startsWith(path.dirname(where.home))) {
        continue
      }
      if (existsSync(mount.dest) && statSync(mount.src).isDirectory()) {
        renameSync(mount.dest, `${mount.dest}.planted`)
      }
      if (statSync(mount.src).isDirectory()) {
        mkdirSync(mount.dest, { recursive: true })
      } else {
        mkdirSync(path.dirname(mount.dest), { recursive: true })
        copyFileSync(mount.src, mount.dest)
      }
    }
  }

  /** One turn of a real Gemini CLI session in the folders, allowing every call and noting each ask. */
  async turn(where: Planted, steps: Step[], resume: string | null = null) {
    this.model.play([steps])
    const config = path.join(where.task, 'gemini-config')
    const launch = geminiLaunch({ node: process.execPath, entry: HOSTILE_ENTRY, config, apiUrl: this.baseUrl })
    const adapter = acpAdapterFor('gemini', launch)
    const asked: ToolCall[] = []
    const decide = async (call: ToolCall) => {
      asked.push(call)
      return Promise.resolve({ allow: true as const })
    }
    const controller = new AbortController()
    const started: RealProcess[] = []
    const launcher: Launcher = {
      sandboxed: true,
      env: { PATH: SEARCH_PATH, HOME: where.home, GEMINI_API_KEY: 'placeholder' },
      spawn: (request) => {
        const start = { command: request.command, args: request.args, cwd: request.cwd ?? where.work, env: request.env }
        const real = new RealProcess({ ...start, tap: passThrough, deaf: false }, request.signal)
        started.push(real)
        return real
      },
    }
    try {
      const spec = { cwd: where.work, resume } as unknown as Parameters<typeof adapter.realise>[0]
      const host = { decide, hooks: null, toolServers: {} }
      const realised = await adapter.realise(spec, launcher, host, controller)
      const inputs = new Channel<SessionInput>()
      const run = new Run(await adapter.open(realised, inputs, null), adapter.project, inputs, {
        controller,
        bound: 60_000,
      })
      run.start().send('go')
      await run.until(isTurnEnd, 'the turn ends')
      run.close()
      return { asked, events: run.events, sessionId: sessionOf(run.events) }
    } finally {
      controller.abort()
      await stopAll(started)
    }
  }
}

const sessionOf = (events: RuntimeEvent[]) => {
  const started = events.find((event) => event.type === 'session.started')
  return started?.type === 'session.started' ? started.sessionId : null
}
