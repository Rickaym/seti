import { INFRA_COMMAND } from './content/cast.js'
import { openDemoPr, repoForDir } from './github.js'

/** Seti's permission callback, as far as the scripted agent calls it. */
export type CanUseTool = (
  tool: string,
  input: Record<string, unknown>,
  options: { signal: AbortSignal; toolUseID: string; requestId: string; decisionReason?: string },
) => Promise<{ behavior: string; message?: string } | null>

/** What a scripted turn can do; every step only writes transcript messages. */
export interface Act {
  cwd: string
  stopped: () => boolean
  say: (text: string) => Promise<void>
  tool: (name: string, input: Record<string, unknown>, output: string) => Promise<void>
  /** Asks the user through Seti's permission prompt; true when they allowed it. */
  ask: (name: string, input: Record<string, unknown>, reason: string) => Promise<boolean>
}

type Step = (act: Act) => Promise<unknown>

const SCRIPTED = 'This reply is scripted: in the demo no agent reads code or runs commands.'

const TRY_NEXT = 'Ask me to open a PR, or to deploy, to see those flows.'

/** A few words of the prompt for branch names and titles. */
function topic(prompt: string): string {
  const words = prompt
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(' ')
    .filter((word) => word.length > 2)
    .slice(0, 5)
  return words.length === 0 ? 'demo change' : words.join(' ')
}

const slugOf = (text: string) => text.replace(/\s+/g, '-').slice(0, 40)

const look: Step[] = [
  async (act) => act.say('I will start with the code this touches.'),
  async (act) => act.tool('Grep', { pattern: 'TODO', path: 'src' }, 'src/app.ts\nsrc/routes/orders.ts'),
  async (act) => act.tool('Read', { file_path: 'src/routes/orders.ts' }, "router.get('/v2/orders', ...)"),
]

const testRun: Step = async (act) =>
  act.tool(
    'Bash',
    { command: 'pnpm test', description: 'Run the tests' },
    ' \u2713 test/orders.test.ts (12 tests) 184ms\n\n Test Files  1 passed (1)\n      Tests  12 passed (12)',
  )

function prTurn(prompt: string): Step[] {
  const title = `fix: ${topic(prompt)}`
  const branch = `demo/${slugOf(topic(prompt))}`
  return [
    ...look,
    async (act) =>
      act.tool(
        'Edit',
        { file_path: 'src/routes/orders.ts', old_string: 'findMany()', new_string: 'findMany({ take: 50 })' },
        'The file src/routes/orders.ts has been updated.',
      ),
    testRun,
    async (act) => {
      const url = openDemoPr(repoForDir(act.cwd), title, branch)
      await act.tool('Bash', { command: `gh pr create --title "${title}"`, description: 'Open the pull request' }, url)
    },
    async (act) => act.say(`The change is in and the tests pass, so I opened a PR. ${SCRIPTED}`),
  ]
}

const DEPLOY_COMMAND = 'make deploy ENV=staging'

const deployTurn: Step[] = [
  async (act) => act.say('Staging first. This needs your go-ahead, so I am asking.'),
  async (act) => {
    const command = repoForDir(act.cwd) === 'acme/infra' ? INFRA_COMMAND : DEPLOY_COMMAND
    const allowed = await act.ask('Bash', { command, description: 'Apply to staging' }, 'No rule allows this command')
    await act.say(
      allowed
        ? `Deployed to staging. Nothing really ran: ${SCRIPTED}`
        : 'Understood, I did not deploy. Tell me when you want it.',
    )
  },
]

const fixTurn: Step[] = [
  ...look,
  testRun,
  async (act) => act.say(`I found the cause and the tests pass with the fix. ${SCRIPTED} ${TRY_NEXT}`),
]

const answerTurn: Step[] = [
  ...look,
  async (act) => act.say(`Here is what I would do next, step by step, once you agree. ${SCRIPTED} ${TRY_NEXT}`),
]

function scriptFor(prompt: string): Step[] {
  const text = prompt.toLowerCase()
  if (/\b(pr|pull request|ship)\b/.test(text)) {
    return prTurn(prompt)
  }
  if (/\b(deploy|release|apply|migrate)\b/.test(text)) {
    return deployTurn
  }
  if (/\b(fix|bug|test|flaky|fail)/.test(text)) {
    return fixTurn
  }
  return answerTurn
}

/** Acts out one turn for the prompt; returns how many steps it played before any interrupt. */
export async function playTurn(prompt: string, act: Act): Promise<number> {
  let played = 0
  for (const step of scriptFor(prompt)) {
    if (act.stopped()) {
      break
    }
    await step(act)
    played += 1
  }
  return Math.max(1, played)
}
