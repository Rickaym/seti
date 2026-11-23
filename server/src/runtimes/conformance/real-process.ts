import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { Readable } from 'node:stream'
import { FakeProcess } from './process.js'

/** What a rig makes of one line the process wrote: the lines Seti reads, and maybe a crash. */
export interface Outbound {
  lines: string[]
  /** The process dies with this exit code once the lines are read. */
  exit?: number
}

/** How a rig stands between Seti and a real runtime process, line by line, both ways. */
export interface LineTap {
  /** A line Seti wrote; returns the lines the process gets. `answer` writes a line back to Seti. */
  inbound: (line: string, answer: (line: string) => void) => string[]
  outbound: (line: string) => Outbound
}

/** A real program a rig starts in place of the sandbox, with the environment the sandbox gives. */
export interface RealStart {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string | undefined>
  tap: LineTap
  /** The process ignores the signal to stop; the program still dies, the exit is never reported. */
  deaf: boolean
}

const eachLine = (input: Readable, take: (line: string) => void): void => {
  createInterface({ input }).on('line', take)
}

/**
 * A real runtime process behind a rig's tap. It runs in its own process group, so stopping it
 * stops what it started; its exit is reported as the process's own unless the rig crashed it.
 */
export class RealProcess extends FakeProcess {
  private readonly child: ChildProcess
  private crashed = false

  constructor(start: RealStart, signal: AbortSignal) {
    super(signal, start.deaf)
    this.child = spawn(start.command, start.args, {
      cwd: start.cwd,
      env: start.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    })
    this.child.on('error', (e) => {
      this.stderr.write(`${e.message}\n`)
      this.finish(127, null)
    })
    this.child.on('exit', (code, exitSignal) => {
      this.stopGroup()
      if (!this.crashed && !start.deaf) {
        this.finish(code, exitSignal)
      }
    })
    this.child.stderr?.pipe(this.stderr, { end: false })
    eachLine(this.stdin, (line) => {
      const answer = (reply: string): void => {
        this.write(reply)
      }
      for (const sent of start.tap.inbound(line, answer)) {
        this.child.stdin?.write(`${sent}\n`)
      }
    })
    if (this.child.stdout !== null) {
      eachLine(this.child.stdout, (line) => {
        const out = start.tap.outbound(line)
        for (const each of out.lines) {
          this.write(each)
        }
        if (out.exit !== undefined) {
          this.crash(out.exit)
        }
      })
    }
  }

  override kill(signal?: NodeJS.Signals | number): boolean {
    this.child.kill(typeof signal === 'string' ? signal : 'SIGTERM')
    return true
  }

  /** Kills the program at once and reports this exit code, as the kernel would after a crash. */
  crash(code: number): void {
    if (this.crashed || this.ended) {
      return
    }
    this.crashed = true
    this.stopGroup()
    this.finish(code, null)
  }

  private write(line: string): void {
    if (!this.ended) {
      this.stdout.write(`${line}\n`)
    }
  }

  private stopGroup(): void {
    const { pid } = this.child
    if (pid === undefined) {
      return
    }
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      // The group is already gone.
    }
  }
}
