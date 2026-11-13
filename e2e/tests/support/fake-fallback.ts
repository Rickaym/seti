import { released, type StepActor } from './fake-steps.js'

/** What a prompt asks for to have a cyber safeguard move the session to a fallback model. */
const FALLBACK_PROMPT = 'trip the cyber safeguard'
/** What a prompt asks for to have the session report its model in a session start. */
export const MODEL_PROMPT = 'report your model'

export const ORIGINAL_MODEL = 'claude-opus-5-5'
export const FALLBACK_MODEL = 'claude-opus-4-8'
export const CVP_URL = 'https://support.claude.com/en/articles/14604842-cyber-verification-program'
export const FALLBACK_EXPLANATION =
  'Cyber safeguards flagged this message. If this is legitimate security work, you can apply for the ' +
  `Cyber Verification Program: ${CVP_URL}`

/** The fallback prompt; after the notice the turn waits until releaseStep(gate, 0) runs. */
export const fallbackPrompt = (gate: string) => `Please ${FALLBACK_PROMPT}, release it through ${gate}`
const GATE = /release it through (\S+)/

type Emit = (m: Record<string, unknown> & { type: string }) => void

const FALLBACK_NOTICE = {
  type: 'system',
  subtype: 'model_refusal_fallback',
  trigger: 'refusal',
  direction: 'retry',
  scope: 'session',
  original_model: ORIGINAL_MODEL,
  fallback_model: FALLBACK_MODEL,
  request_id: 'req_fake_refusal',
  api_refusal_category: 'cyber',
  api_refusal_explanation: FALLBACK_EXPLANATION,
  api_refusal_cyber_verification: { type: 'inactive' },
  retracted_message_uuids: [],
  refused_user_message_uuid: null,
  content: "Opus 5.5's safeguards flagged this session.",
}

/** Plays the turns about the session's model: a refusal fallback, /model and a model report. */
export class FallbackPlayer {
  private model = ORIGINAL_MODEL
  private readonly emit: Emit

  constructor(emit: Emit) {
    this.emit = emit
  }

  /** Plays the turn the prompt asks for, or returns null when the prompt is not about the model. */
  play(prompt: string, actor: StepActor): Promise<void> | null {
    const gate = GATE.exec(prompt)?.[1]
    if (gate !== undefined) {
      return this.refuse(actor, gate)
    }
    const model = /^\/model (\S+)/.exec(prompt)?.[1]
    if (model === undefined && !prompt.includes(MODEL_PROMPT)) {
      return null
    }
    this.init()
    if (model === undefined) {
      actor.assistant([{ type: 'text', text: `Running on ${this.model}.` }])
    } else {
      this.model = model
      const content = `<local-command-stdout>Set model to ${model}</local-command-stdout>`
      this.emit({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content } })
    }
    return Promise.resolve()
  }

  private init(): void {
    const session = { permissionMode: 'auto', cwd: '', tools: [], plugins: [], mcp_servers: [] }
    this.emit({ type: 'system', subtype: 'init', model: this.model, ...session })
  }

  private async refuse(actor: StepActor, gate: string): Promise<void> {
    this.model = ORIGINAL_MODEL
    this.init()
    actor.assistant([{ type: 'text', text: 'Looking at the exploit.' }])
    this.model = FALLBACK_MODEL
    this.emit(FALLBACK_NOTICE)
    if (await released(actor, gate, 0)) {
      actor.assistant([{ type: 'text', text: 'Carried on with the fallback model.' }])
    }
  }
}
