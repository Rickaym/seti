import fs from 'node:fs'
import path from 'node:path'
import { CLAUDE_HOME } from '../config.js'
import { projectSlug } from '../sandbox-mounts.js'

const CHUNK = 1 << 20
const COST_STATE = '"type":"cost-state"'

/** The session file Claude Code keeps for a session of an agent working in `cwd`. */
export const sessionFile = (sessionId: string, cwd: string, claudeHome = CLAUDE_HOME) =>
  path.join(claudeHome, 'projects', projectSlug(cwd), `${sessionId}.jsonl`)

function totalOf(line: string): number | null {
  try {
    const entry = JSON.parse(line) as { totalCostUSD?: unknown }
    return typeof entry.totalCostUSD === 'number' && Number.isFinite(entry.totalCostUSD) ? entry.totalCostUSD : null
  } catch {
    return null
  }
}

/** The newest cost line in `text`, scanning complete lines from the end. */
function newestTotal(text: string): number | null {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? ''
    if (line.includes(COST_STATE)) {
      const total = totalOf(line)
      if (total !== null) {
        return total
      }
    }
  }
  return null
}

/**
 * The running cost total the session file last saved, which a fork of the session starts from;
 * 0 when it saved none or cannot be read. Reads backwards a chunk at a time.
 */
export function savedTotal(file: string): number {
  let fd: number
  try {
    fd = fs.openSync(file, 'r')
  } catch {
    return 0
  }
  try {
    let end = fs.fstatSync(fd).size
    let carry = Buffer.alloc(0)
    while (end > 0) {
      const start = Math.max(0, end - CHUNK)
      const chunk = Buffer.alloc(end - start)
      fs.readSync(fd, chunk, 0, chunk.length, start)
      const bytes = Buffer.concat([chunk, carry])
      const newline = bytes.indexOf(0x0a)
      let cut = newline === -1 ? bytes.length : newline + 1
      if (start === 0) {
        cut = 0
      }
      const found = newestTotal(bytes.subarray(cut).toString('utf8'))
      if (found !== null) {
        return found
      }
      carry = bytes.subarray(0, cut)
      end = start
    }
    return 0
  } finally {
    fs.closeSync(fd)
  }
}
