import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** Turns the fake Claude Code plays one step at a time, each held until the test releases it. */
const GATED = /release each through (\S+)/
const GATE_POLL_MS = 20

/** What a prompt asks for to get a run of shell calls, each result held until released. */
const BURST_PROMPT = 'run the checks one by one'
export const BURST_COMMANDS = ['npm run lint', 'npm run typecheck', 'npm test', 'npm run build'] as const
export const BURST_DONE = 'All checks pass.'

/** What a prompt asks for to get a plan kept with Claude Code's task tools, a step at a time. */
const PLAN_PROMPT = 'work through a plan'
const PLAN_ITEMS = [
  { subject: 'Read the code', activeForm: 'Reading the code' },
  { subject: 'Fix the bug', activeForm: 'Fixing the bug' },
  { subject: 'Run the tests', activeForm: 'Running the tests' },
] as const

/** The burst prompt; the result of call n waits until releaseStep(gate, n) runs. */
export const burstPrompt = (gate: string) => `Please ${BURST_PROMPT}, release each through ${gate}`

/** The plan prompt; step n waits until releaseStep(gate, n) runs, and the last one asks. */
export const planPrompt = (gate: string) => `Please ${PLAN_PROMPT}, release each through ${gate}`

export function releaseStep(gate: string, n: number): void {
  fs.writeFileSync(path.join(gate, String(n)), '')
}

/** The folder a stepped prompt waits on, or undefined for any other prompt. */
export const gateOf = (prompt: string) => GATED.exec(prompt)?.[1]

/** What the fake Claude Code lends a stepped turn. */
export interface StepActor {
  assistant: (content: unknown[]) => void
  toolResult: (toolUseId: string, content: string, output?: unknown) => void
  /** Whether the session ended, which ends the turn too. */
  ended: () => boolean
}

const sleep = async (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })

/** Waits for the test to release step n; false when the session ended meanwhile. */
async function released(actor: StepActor, gate: string, n: number): Promise<boolean> {
  while (!fs.existsSync(path.join(gate, String(n)))) {
    if (actor.ended()) {
      return false
    }
    await sleep(GATE_POLL_MS)
  }
  return true
}

/** Streams the burst's calls one at a time; each result waits for its file in the gate folder. */
async function burst(actor: StepActor, gate: string): Promise<void> {
  actor.assistant([{ type: 'text', text: 'Running the checks.' }])
  for (const [n, command] of BURST_COMMANDS.entries()) {
    const id = `toolu_burst_${String(n)}_${randomUUID().slice(0, 8)}`
    actor.assistant([{ type: 'tool_use', id, name: 'Bash', input: { command } }])
    if (!(await released(actor, gate, n))) {
      return
    }
    actor.toolResult(id, `${command}: ok`)
  }
  actor.assistant([{ type: 'text', text: BURST_DONE }])
}

interface TaskCall {
  name: string
  input: Record<string, unknown>
  content: string
  output: unknown
}

function taskTool(actor: StepActor, { name, input, content, output }: TaskCall): void {
  const id = `toolu_plan_${randomUUID().slice(0, 8)}`
  actor.assistant([{ type: 'tool_use', id, name, input }])
  actor.toolResult(id, content, output)
}

function setStatus(actor: StepActor, taskId: string, status: string): void {
  const output = { success: true, taskId, updatedFields: ['status'] }
  taskTool(actor, { name: 'TaskUpdate', input: { taskId, status }, content: `Updated task #${taskId} status`, output })
}

/** Plans PLAN_ITEMS with the task tools, works through two a step at a time, then asks. */
async function plan(actor: StepActor, gate: string, question: string): Promise<void> {
  for (const [n, item] of PLAN_ITEMS.entries()) {
    const id = String(n + 1)
    const created = `Task #${id} created successfully: ${item.subject}`
    const input = { ...item, description: item.subject }
    taskTool(actor, { name: 'TaskCreate', input, content: created, output: { task: { id, subject: item.subject } } })
  }
  setStatus(actor, '1', 'in_progress')
  for (const n of [1, 2]) {
    if (!(await released(actor, gate, n - 1))) {
      return
    }
    setStatus(actor, String(n), 'completed')
    setStatus(actor, String(n + 1), 'in_progress')
  }
  actor.assistant([{ type: 'text', text: question }])
}

/** Plays the stepped turn the prompt asks for; a plan ends with `question`. */
export async function actSteps(prompt: string, gate: string, actor: StepActor, question: string): Promise<void> {
  await (prompt.includes(PLAN_PROMPT) ? plan(actor, gate, question) : burst(actor, gate))
}
