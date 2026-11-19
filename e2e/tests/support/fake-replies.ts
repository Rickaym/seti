/** What a prompt asks for to get a turn that ends with ASK_REPLY, a question for the user. */
export const ASK_PROMPT = 'ask me which branch'
export const ASK_REPLY = 'The fix is ready on two branches.\n\nWhich one should I push?'

/** What a prompt asks for to get a turn that ends with CHOICE_REPLY: a question and its answers. */
export const CHOICE_PROMPT = 'offer me two branches'
export const CHOICE_OPTIONS = ['main', 'release/2026-11-hotfix-for-the-login-redirect-loop'] as const
export const CHOICE_QUESTION = 'Should I push to one of these now?'
const CHOICE_REPLY = `The fix is ready.\n\n${CHOICE_QUESTION}\n\n1. ${CHOICE_OPTIONS[0]}\n2. ${CHOICE_OPTIONS[1]}`

/** What the fake agent says to a prompt that asks for nothing else. */
export function plainReply(prompt: string): string {
  if (prompt.includes(CHOICE_PROMPT)) {
    return CHOICE_REPLY
  }
  return prompt.includes(ASK_PROMPT) ? ASK_REPLY : 'Done.'
}
