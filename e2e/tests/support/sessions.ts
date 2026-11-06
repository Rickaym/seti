import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { paths } from './env.js'

const LAPTOP_CWD = String.raw`C:\Users\e2e\app`

export const SEEDED = {
  login: {
    id: '0e2e0000-0000-4000-8000-000000000001',
    title: 'E2E login fix',
    prompt: 'Fix the login redirect and open a PR',
    reply: 'The redirect now keeps the return path.',
    pr: 'https://github.com/e2e/app/pull/12',
  },
  notes: {
    id: '0e2e0000-0000-4000-8000-000000000002',
    title: 'E2E release notes',
    prompt: 'Draft the release notes',
    reply: 'Here are the release notes.',
  },
  laptop: {
    id: '0e2e0000-0000-4000-8000-000000000003',
    title: 'E2E laptop session',
    prompt: 'Continue the laptop work',
    reply: 'Picked up where the laptop left off.',
  },
} as const

interface Line {
  type: 'user' | 'assistant'
  message: unknown
}

const user = (content: unknown): Line => ({ type: 'user', message: { role: 'user', content } })

const assistant = (content: unknown[]): Line => ({
  type: 'assistant',
  message: {
    id: `msg_${randomUUID()}`,
    type: 'message',
    role: 'assistant',
    model: 'claude-e2e',
    content,
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  },
})

function writeSession(
  dir: string,
  session: { id: string; title: string },
  where: { cwd: string; branch: string; start: number },
  lines: Line[],
) {
  let parent: string | null = null
  const entries: object[] = lines.map((line, index) => {
    const uuid = randomUUID()
    const entry = {
      parentUuid: parent,
      isSidechain: false,
      ...line,
      uuid,
      timestamp: new Date(where.start + index * 60_000).toISOString(),
      userType: 'external',
      entrypoint: 'cli',
      cwd: where.cwd,
      sessionId: session.id,
      version: '2.1.0',
      gitBranch: where.branch,
    }
    parent = uuid
    return entry
  })
  entries.push({ type: 'custom-title', customTitle: session.title, sessionId: session.id })
  const file = path.join(dir, `${session.id}.jsonl`)
  fs.writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`)
  const at = new Date(where.start + lines.length * 60_000)
  fs.utimesSync(file, at, at)
}

/** Claude Code project folder for a working directory, as the CLI names it. */
export const projectDir = (cwd: string) => path.join(paths.claudeHome, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))

/** Writes terminal sessions into the server's Claude config, as if run from a shell on this box. */
export function seedSessions(): void {
  const dir = projectDir(paths.checkout)
  fs.mkdirSync(dir, { recursive: true })
  const hour = 3_600_000
  const now = Date.now()
  const { login, notes, laptop } = SEEDED
  writeSession(dir, login, { cwd: paths.checkout, branch: 'feat/login', start: now - 3 * hour }, [
    user(login.prompt),
    assistant([{ type: 'thinking', thinking: 'plan', signature: 'sig' }]),
    assistant([{ type: 'tool_use', id: 'toolu_e2e_pr', name: 'Bash', input: { command: 'gh pr create --fill' } }]),
    user([{ type: 'tool_result', tool_use_id: 'toolu_e2e_pr', content: `Creating pull request\n${login.pr}\n` }]),
    assistant([{ type: 'text', text: `${login.reply} See https://github.com/e2e/docs/pull/4 too.` }]),
  ])
  writeSession(dir, notes, { cwd: paths.checkout, branch: 'main', start: now - 5 * hour }, [
    user(notes.prompt),
    assistant([{ type: 'text', text: notes.reply }]),
  ])
  writeSession(dir, laptop, { cwd: LAPTOP_CWD, branch: 'feat/laptop', start: now - 7 * hour }, [
    user(laptop.prompt),
    assistant([{ type: 'text', text: laptop.reply }]),
  ])
}
