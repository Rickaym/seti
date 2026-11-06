import fs from 'node:fs'
import path from 'node:path'

/**
 * A Claude Code stand-in holding more memory than its tool has when a 300 MB cap hits. It starts
 * the tool through CLAUDE_CODE_SHELL_PREFIX as Claude Code does, or directly when told to.
 */
const ROOT = `
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const adj = () => fs.readFileSync('/proc/self/oom_score_adj', 'utf8').trim()
const oomGroup = () => {
  try {
    const unified = fs.readFileSync('/proc/self/cgroup', 'utf8').split('\\n')[0].slice(3)
    return fs.readFileSync(path.join('/sys/fs/cgroup', unified, 'memory.oom.group'), 'utf8').trim()
  } catch {
    return null
  }
}
const quote = (text) => "'" + text.replaceAll("'", "'\\\\''") + "'"
const before = adj()
const held = []
for (let i = 0; i < 160; i++) held.push(Buffer.alloc(1 << 20, 1))
const tool = path.join(__dirname, process.argv[2])
const prefix = process.argv[3] === 'direct' ? '' : (process.env.CLAUDE_CODE_SHELL_PREFIX ?? '')
const stdio = ['ignore', 'pipe', 'ignore']
const child =
  prefix === ''
    ? spawn(process.execPath, [tool], { stdio })
    : spawn('/bin/bash', ['-c', quote(prefix) + ' ' + quote(quote(process.execPath) + ' ' + quote(tool))], { stdio })
let seen = ''
child.stdout.on('data', (chunk) => (seen += chunk))
child.on('close', (code, signal) => {
  const result = { before, after: adj(), held: held.length, oomGroup: oomGroup() }
  console.log(JSON.stringify({ ...result, child: { code, signal, adj: seen.trim() } }))
})
`

/** Waits until something raised its adj and the guard had time to name it, then fills the cap. */
const HOG = `
const fs = require('node:fs')
const adj = () => Number(fs.readFileSync('/proc/self/oom_score_adj', 'utf8'))
const pause = new Int32Array(new SharedArrayBuffer(4))
const until = Date.now() + 5000
while (adj() < 800 && Date.now() < until) Atomics.wait(pause, 0, 0, 20)
process.stdout.write(String(adj()) + '\\n')
Atomics.wait(pause, 0, 0, 500)
const held = []
for (let i = 0; i < 600; i++) held.push(Buffer.alloc(1 << 20, 1))
`

/** Fills the cap the moment it starts, before any poller could look at it. */
const RUSH = `
const fs = require('node:fs')
process.stdout.write(fs.readFileSync('/proc/self/oom_score_adj', 'utf8').trim() + '\\n')
const held = Buffer.alloc(600 << 20, 1)
`

/**
 * Writes the root and its tools into `dir`; returns the arguments to run the root with node.
 * `hog` waits for the guard and starts directly, `rush` starts as Claude Code starts a command.
 */
export function oomScriptArgs(dir: string, tool: 'hog' | 'rush'): string[] {
  fs.writeFileSync(path.join(dir, 'hog.cjs'), HOG)
  fs.writeFileSync(path.join(dir, 'rush.cjs'), RUSH)
  fs.writeFileSync(path.join(dir, 'root.cjs'), ROOT)
  return [path.join(dir, 'root.cjs'), `${tool}.cjs`, ...(tool === 'hog' ? ['direct'] : [])]
}

export interface OomRun {
  before: string
  after: string
  held: number
  oomGroup: string | null
  child: { code: number | null; signal: string | null; adj: string }
}

/** The root's report: the last line it printed. */
export const oomRun = (out: string) => JSON.parse(out.trim().split('\n').at(-1) ?? '{}') as OomRun
