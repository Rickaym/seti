import { randomUUID } from 'node:crypto'
import type { CanUseTool } from './fake-permission.js'
import type { StepActor } from './fake-steps.js'

/** What a prompt asks for to have the agent ask through AskUserQuestion and wait for answers. */
export const QUESTION_PROMPT = 'ask me through the question tool'
export const PUSH_PROMPT = `${QUESTION_PROMPT} about pushing`
export const CHECKS_PROMPT = `${QUESTION_PROMPT} about the checks`
export const MERGE_PROMPT = `${QUESTION_PROMPT} about the merge`

export const PUSH_QUESTION = 'Should I push the fix to main?'
export const CHECKS_QUESTION = 'Which checks should I run first?'
export const REPORT_QUESTION = 'Where should the report go?'
export const MERGE_QUESTION = 'How should I merge the PR?'
export const MERGE_RECOMMENDED = 'Squash (Recommended)'

const option = (label: string, description: string) => ({ label, description })

const PUSH = {
  questions: [
    {
      question: PUSH_QUESTION,
      header: 'Push',
      multiSelect: false,
      options: [option('Yes', 'Push it now'), option('No', 'Keep it local')],
    },
  ],
}

const CHECKS = {
  questions: [
    {
      question: CHECKS_QUESTION,
      header: 'Checks',
      multiSelect: true,
      options: [option('Unit', 'pnpm test'), option('Lint', 'pnpm lint'), option('E2E', 'pnpm e2e')],
    },
    {
      question: REPORT_QUESTION,
      header: 'Report',
      multiSelect: false,
      options: [option('PR comment', 'On the PR'), option('Chat', 'In the group chat')],
    },
  ],
}

const MERGE = {
  questions: [
    {
      question: MERGE_QUESTION,
      header: 'Merge',
      multiSelect: false,
      options: [option(MERGE_RECOMMENDED, 'One commit on main'), option('Merge', 'Keep every commit')],
    },
  ],
}

/** The AskUserQuestion input a question prompt sends. */
function questionInput(prompt: string) {
  if (prompt.includes(MERGE_PROMPT)) {
    return MERGE
  }
  return prompt.includes(CHECKS_PROMPT) ? CHECKS : PUSH
}

/** The reply an agent writes once its questions come back, one `question: answer` per question. */
const answeredReply = (answers: Record<string, string | string[]>) =>
  `Got your answers. ${Object.entries(answers)
    .map(([question, answer]) => `${question} ${Array.isArray(answer) ? answer.join(' + ') : answer}`)
    .join(' | ')}`

/** Asks Seti the prompt's questions as Claude Code would; returns the tool result and the reply. */
async function askQuestions(
  canUseTool: CanUseTool | undefined,
  toolUseId: string,
  prompt: string,
): Promise<{ result: string; reply: string }> {
  const answer = await canUseTool?.('AskUserQuestion', questionInput(prompt), {
    signal: new AbortController().signal,
    toolUseID: toolUseId,
    requestId: `req_${toolUseId}`,
  })
  if (answer?.behavior !== 'allow') {
    const why = answer?.message ?? 'No permission callback'
    return { result: why, reply: `No answers: ${why}` }
  }
  const answers = (answer.updatedInput?.answers ?? {}) as Record<string, string | string[]>
  return { result: 'User has answered your questions.', reply: answeredReply(answers) }
}

/** Asks the prompt's questions through AskUserQuestion, then says what the user answered. */
export async function actQuestions(prompt: string, canUseTool: CanUseTool | undefined, actor: StepActor) {
  const id = `toolu_ask_${randomUUID().slice(0, 8)}`
  actor.assistant([{ type: 'tool_use', id, name: 'AskUserQuestion', input: questionInput(prompt) }])
  const { result, reply } = await askQuestions(canUseTool, id, prompt)
  if (!actor.ended()) {
    actor.toolResult(id, result)
    actor.assistant([{ type: 'text', text: reply }])
  }
}
