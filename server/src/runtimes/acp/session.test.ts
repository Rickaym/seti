import { createInterface } from 'node:readline'
import type { ToolCall } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import type { SessionInput, SessionReport } from '../adapter.js'
import { FakeProcess } from '../conformance/process.js'
import { Channel } from '../conformance/run.js'
import type { AcpDecide } from './permissions.js'
import { acpSession, type AcpRealised } from './session.js'

type Message = Record<string, unknown> & { id?: number; method?: string; params?: Record<string, unknown> }

/** A scripted ACP agent on a fake process: it answers Seti's requests with the handler's replies. */
class FakeAgent {
  readonly process = new FakeProcess(new AbortController().signal)
  readonly sent: Message[] = []
  private readonly waiting: ((message: Message) => void)[] = []

  constructor(handle: (message: Message, agent: FakeAgent) => void) {
    createInterface({ input: this.process.stdin }).on('line', (line) => {
      const message = JSON.parse(line) as Message
      this.sent.push(message)
      for (const wake of this.waiting.splice(0)) {
        wake(message)
      }
      handle(message, this)
    })
  }

  write(message: Message): void {
    this.process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  }

  update(update: Record<string, unknown>): void {
    this.write({ method: 'session/update', params: { sessionId: 's1', update } })
  }

  /** The next message Seti sends that matches. */
  async next(match: (message: Message) => boolean): Promise<Message> {
    const seen = this.sent.find(match)
    if (seen !== undefined) {
      return seen
    }
    return new Promise((resolve) => {
      const wait = (message: Message) => {
        if (match(message)) {
          resolve(message)
        } else {
          this.waiting.push(wait)
        }
      }
      this.waiting.push(wait)
    })
  }
}

/** Answers `initialize` and `session/new`; prompts go to the case. */
function opening(prompt: (message: Message, agent: FakeAgent) => void) {
  return (message: Message, agent: FakeAgent) => {
    if (message.method === 'initialize') {
      agent.write({ id: message.id, result: { protocolVersion: 1 } })
    } else if (message.method === 'session/new') {
      agent.write({ id: message.id, result: { sessionId: 's1' } })
    } else if (message.method === 'session/prompt') {
      prompt(message, agent)
    }
  }
}

const allowAll: AcpDecide = async () => Promise.resolve({ allow: true })

function open(agent: FakeAgent, decide: AcpDecide = allowAll) {
  const inputs = new Channel<SessionInput>()
  const realised: AcpRealised = {
    label: 'Fake agent',
    command: 'agent',
    args: [],
    cwd: '/work',
    env: {},
    resume: null,
    model: 'model-1',
    mcpServers: [],
    spawn: () => agent.process,
    decide,
    signal: new AbortController().signal,
  }
  const session = acpSession(realised, inputs)
  const reports: SessionReport[] = []
  const reading = (async () => {
    for await (const report of session.events) {
      reports.push(report)
    }
  })()
  const send = (text: string) => {
    inputs.push({ id: `in-${text}`, content: { text, images: [] } })
  }
  return { session, reports, reading, send }
}

const records = (reports: readonly SessionReport[]) =>
  reports.flatMap((report) => (report.type === 'message' ? [report.raw as Record<string, unknown>] : []))

const SHELL = {
  toolCallId: 'run_shell_command__1',
  status: 'pending',
  title: 'make deploy',
  kind: 'execute',
  content: [{ type: 'content', content: { type: 'text', text: '[current working directory /work] (Deploy)' } }],
}

/** Options in the order Gemini CLI sends them, the session-wide one first. */
const OPTIONS = [
  { optionId: 'proceed_always', name: 'Allow for this session', kind: 'allow_always' },
  { optionId: 'proceed_once', name: 'Allow', kind: 'allow_once' },
  { optionId: 'cancel', name: 'Reject', kind: 'reject_once' },
]

describe('an ACP session', () => {
  it('answers a permission request for this call only, allowed or refused, never for the session', async () => {
    const decided: ToolCall[] = []
    const verdicts = [true, false]
    let replied = Promise.resolve()
    const agent = new FakeAgent(
      opening((prompt, fake) => {
        fake.write({
          id: 0,
          method: 'session/request_permission',
          params: { sessionId: 's1', options: OPTIONS, toolCall: SHELL },
        })
        fake.write({
          id: 1,
          method: 'session/request_permission',
          params: { sessionId: 's1', options: OPTIONS, toolCall: SHELL },
        })
        replied = Promise.all([
          fake.next((m) => m.id === 0 && 'result' in m),
          fake.next((m) => m.id === 1 && 'result' in m),
        ]).then(() => {
          fake.write({ id: prompt.id, result: { stopReason: 'end_turn' } })
        })
      }),
    )
    const { send, session } = open(agent, async (call) => {
      decided.push(call)
      const allow = verdicts.shift() ?? false
      return Promise.resolve(allow ? { allow } : { allow, message: 'no deploys' })
    })
    send('go')
    await agent.next((m) => m.id === 1 && 'result' in m)
    const answers = agent.sent.filter((m) => 'result' in m).map((m) => m.result)
    expect(answers).toEqual([
      { outcome: { outcome: 'selected', optionId: 'proceed_once' } },
      { outcome: { outcome: 'selected', optionId: 'cancel' } },
    ])
    expect(JSON.stringify(agent.sent)).not.toContain('proceed_always')
    expect(decided[0]).toMatchObject({ kind: 'shell', shell: { command: 'make deploy', description: 'Deploy' } })
    await replied
    session.close()
  })

  it('stores a run of message chunks as one update, drops state reports, and ends the turn with its text', async () => {
    const agent = new FakeAgent(
      opening((prompt, fake) => {
        fake.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello, ' } })
        fake.update({ sessionUpdate: 'usage_update', used: 10, size: 100 })
        fake.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'world.' } })
        fake.write({ id: prompt.id, result: { stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 2 } } })
      }),
    )
    const { send, session, reports } = open(agent)
    send('hi')
    await expect.poll(() => records(reports).some((r) => r.seti === 'ended')).toBe(true)
    const stored = records(reports)
    expect(stored.map((r) => r.seti)).toEqual(['started', 'turn', 'update', 'ended'])
    expect(stored[2]).toMatchObject({ update: { content: { text: 'Hello, world.' } } })
    expect(stored[3]).toMatchObject({ result: 'Hello, world.', usage: { inputTokens: 5, outputTokens: 2 } })
    const end = reports.find((r) => r.type === 'message' && (r.raw as { seti?: string }).seti === 'ended')
    expect(end).toMatchObject({ delivered: ['in-hi'] })
    session.close()
  })

  it('holds an input sent during a turn until the turn ends, then runs it as the next turn', async () => {
    const prompts: Message[] = []
    const agent = new FakeAgent(
      opening((prompt) => {
        prompts.push(prompt)
      }),
    )
    const { send, session, reports } = open(agent)
    send('one')
    await expect.poll(() => prompts.length).toBe(1)
    send('two')
    await expect
      .poll(() => reports.some((r) => r.type === 'input' && r.id === 'in-two' && r.state === 'queued'))
      .toBe(true)
    expect(prompts).toHaveLength(1)
    agent.write({ id: prompts[0]?.id, result: { stopReason: 'end_turn' } })
    await expect.poll(() => prompts.length).toBe(2)
    session.close()
  })

  it('cancels a turn: answers waiting asks cancelled and lists the calls it cut', async () => {
    const agent = new FakeAgent(
      opening((prompt, fake) => {
        fake.update({ sessionUpdate: 'tool_call', ...SHELL })
        fake.write({
          id: 7,
          method: 'session/request_permission',
          params: { sessionId: 's1', options: OPTIONS, toolCall: SHELL },
        })
        void fake
          .next((m) => m.method === 'session/cancel')
          .then(() => {
            fake.write({ id: prompt.id, result: { stopReason: 'cancelled' } })
          })
      }),
    )
    const { send, session, reports } = open(agent, async (_call, signal) => {
      await new Promise((resolve) => {
        signal.addEventListener('abort', resolve)
      })
      return { allow: true }
    })
    send('go')
    await expect.poll(() => records(reports).some((r) => r.seti === 'update')).toBe(true)
    await session.interrupt()
    await expect.poll(() => records(reports).some((r) => r.seti === 'ended')).toBe(true)
    expect(agent.sent.find((m) => m.id === 7)?.result).toEqual({ outcome: { outcome: 'cancelled' } })
    expect(records(reports).find((r) => r.seti === 'ended')).toMatchObject({
      stopReason: 'cancelled',
      unfinished: ['run_shell_command__1'],
    })
    session.close()
  })

  it('drops the history a loaded session replays, and stores its start only with its first turn', async () => {
    const agent = new FakeAgent((message, fake) => {
      if (message.method === 'initialize') {
        fake.write({ id: message.id, result: { protocolVersion: 1 } })
      } else if (message.method === 'session/load') {
        fake.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old reply' } })
        fake.write({ id: message.id, result: null })
      } else if (message.method === 'session/prompt') {
        fake.write({ id: message.id, result: { stopReason: 'end_turn' } })
      }
    })
    const inputs = new Channel<SessionInput>()
    const session = acpSession(
      {
        label: 'Fake agent',
        command: 'agent',
        args: [],
        cwd: '/work',
        env: {},
        resume: 's1',
        model: 'model-1',
        mcpServers: [],
        spawn: () => agent.process,
        decide: allowAll,
        signal: new AbortController().signal,
      },
      inputs,
    )
    const reports: SessionReport[] = []
    void (async () => {
      for await (const report of session.events) {
        reports.push(report)
      }
    })()
    await agent.next((m) => m.method === 'session/load')
    inputs.push({ id: 'in-again', content: { text: 'again', images: [] } })
    await expect.poll(() => records(reports).some((r) => r.seti === 'ended')).toBe(true)
    expect(records(reports).map((r) => r.seti)).toEqual(['started', 'turn', 'ended'])
    expect(JSON.stringify(reports)).not.toContain('old reply')
    session.close()
  })
})
