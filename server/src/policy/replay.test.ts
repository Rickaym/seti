import { describe, expect, it } from 'vitest'
import { compareOutcomes, type ClaudeOutcome, type ShadowClass } from './compare.js'
import { CWD, decideClaude, HOME, type Setup } from './policy-fixtures.js'

/**
 * A tool call, the setup it ran in, what Claude Code does with it (from its documentation, or
 * what the real binary would do where the e2e fake only stands in), and how Seti's decision
 * compares. A case expected to differ says why in its label.
 */
type Case = [
  label: string,
  setup: Setup,
  tool: string,
  input: Record<string, unknown>,
  claude: ClaudeOutcome,
  expected?: ShadowClass,
]

const U = { sandboxed: false, guard: true } as const
const S = { sandboxed: true, guard: true } as const
/** Documented cases leave Seti's guard out: they pin the rules alone. */
const D = { sandboxed: false } as const
const manual = { ...D, mode: 'ask' } as const
const sh = (command: string) => ({ command })

const E2E_FAKE: Case[] = [
  ['permission request: make deploy', U, 'Bash', sh('make deploy'), 'classifier'],
  ['plan approval', U, 'ExitPlanMode', { plan: 'x' }, 'ask'],
  ['question', U, 'AskUserQuestion', { questions: [] }, 'ask'],
  [
    'reviewed send',
    { ...U, rules: [['review', 'mcp__chat']] },
    'mcp__chat__send_message',
    { text: 'x' },
    'allow',
    'seti-hook',
  ],
  ['repeated build', U, 'Bash', sh('pnpm build'), 'classifier'],
  ['burst in the sandbox', S, 'Bash', sh('npm run lint'), 'classifier'],
  ['burst outside it', U, 'Bash', sh('npm test'), 'classifier'],
  [
    'background dev server',
    U,
    'Bash',
    { command: 'echo "listening"; while true; do sleep 1; done', run_in_background: true },
    'classifier',
  ],
]

const FIXTURES: Case[] = [
  ['pr create', U, 'Bash', sh('gh pr create --fill'), 'classifier'],
  ['pr list, a built-in read', U, 'Bash', sh('gh pr list -R a/b'), 'allow'],
  ['pr view, a built-in read', U, 'Bash', sh('gh pr view 3'), 'allow'],
  ['push', U, 'Bash', sh('git push -q -u origin ci/gates'), 'classifier'],
  ['pr comment', U, 'Bash', sh('gh pr comment 7 --body "see #9"'), 'classifier'],
]

const npmGit = {
  ...manual,
  rules: [
    ['allow', 'Bash(npm run *)'],
    ['allow', 'Bash(git commit *)'],
    ['deny', 'Bash(git push *)'],
  ],
} as const
const clean = { ...D, rules: [['ask', 'Bash(git clean *)']] } as const
const npmTest = {
  ...manual,
  rules: [
    ['allow', 'Bash(npm test *)'],
    ['deny', 'Bash(rm *)'],
    ['allow', 'Bash(grep *)'],
  ],
} as const
const env = {
  ...manual,
  rules: [
    ['deny', 'Read(./.env)'],
    ['allow', 'WebFetch(domain:*.example.com)'],
    ['allow', 'mcp__puppeteer'],
  ],
} as const

const DOCUMENTED: Case[] = [
  ['npm script', npmGit, 'Bash', sh('npm run build'), 'allow'],
  ['commit', npmGit, 'Bash', sh('git commit -m "fix"'), 'allow'],
  ['push denied', npmGit, 'Bash', sh('git push origin main'), 'deny'],
  ['push in another form', npmGit, 'Bash', sh('git -C . push origin main'), 'ask'],
  ['compound with an unallowed part', npmGit, 'Bash', sh('npm run build && curl x'), 'ask'],
  ['ask rule after cd', clean, 'Bash', sh('cd /tmp && git clean -f'), 'ask'],
  ['ask rule in a substitution', clean, 'Bash', sh('echo "$(git clean -f)"'), 'ask'],
  ['dangling operator', { ...manual, rules: [['allow', 'Bash(npm *)']] }, 'Bash', sh('npm test &&'), 'ask'],
  ['wrapper stripped', npmTest, 'Bash', sh('timeout 30 npm test'), 'allow'],
  ['safe variable stripped', npmTest, 'Bash', sh('NODE_ENV=test npm test'), 'allow'],
  ['other variable kept', npmTest, 'Bash', sh('FOO=bar npm test'), 'ask'],
  ['deny past any variable', npmTest, 'Bash', sh('FOO=bar rm -rf tmp/'), 'deny'],
  ['bare xargs stripped', npmTest, 'Bash', sh('xargs grep pattern'), 'allow'],
  ['xargs with flags kept', npmTest, 'Bash', sh('xargs -n1 grep pattern'), 'ask'],
  ['exec wrapper', { ...manual, rules: [['allow', 'Bash(watch *)']] }, 'Bash', sh('watch make'), 'ask'],
  [
    'find action, exact',
    { ...manual, rules: [['allow', 'Bash(find build -type f -delete)']] },
    'Bash',
    sh('find build -type f -delete'),
    'allow',
  ],
  ['read deny', env, 'Read', { file_path: `${CWD}/.env` }, 'deny'],
  ['read deny through cat', env, 'Bash', sh('cat .env'), 'deny'],
  ['subdomain allowed', env, 'WebFetch', { url: 'https://api.example.com/x' }, 'allow'],
  ['bare domain not', env, 'WebFetch', { url: 'https://example.com/x' }, 'ask'],
  ['whole server', env, 'mcp__puppeteer__navigate', { url: 'x' }, 'allow'],
  [
    'home removal in bypass, which the guard refuses first',
    { ...S, mode: 'bypass' },
    'Bash',
    sh('rm -rf ~'),
    'ask',
    'seti-hook',
  ],
  ['home removal in bypass', { sandboxed: true, mode: 'bypass' }, 'Bash', sh('rm -rf ~'), 'ask'],
  ['protected write in bypass', { ...D, mode: 'bypass' }, 'Edit', { file_path: `${CWD}/.git/config` }, 'allow'],
  ['protected write in auto', D, 'Edit', { file_path: `${CWD}/.git/config` }, 'classifier'],
  ['protected write by default', manual, 'Edit', { file_path: `${CWD}/.git/config` }, 'ask'],
  ['edit inside in auto', D, 'Edit', { file_path: `${CWD}/src/a.ts` }, 'allow'],
  ['edit outside in auto', D, 'Edit', { file_path: '/etc/hosts' }, 'classifier'],
  ['sandboxed shell in auto, its Bash allow dropped', S, 'Bash', sh('npm test'), 'classifier'],
  ['sandboxed shell by default', { ...S, mode: 'ask' }, 'Bash', sh('npm test'), 'allow'],
  ['ask rule in bypass', { ...D, mode: 'bypass', rules: [['ask', 'Bash(git push:*)']] }, 'Bash', sh('git push'), 'ask'],
  ['question in bypass', { ...D, mode: 'bypass' }, 'AskUserQuestion', {}, 'ask'],
  ['credentials', D, 'Read', { file_path: `${HOME}/.ssh/id_rsa` }, 'deny'],
  [
    'deny by path is not a boundary',
    { ...D, rules: [['deny', 'Bash(curl *)']] },
    'Bash',
    sh('/usr/bin/curl x'),
    'classifier',
  ],
]

const KNOWN_DIFFERENCES: Case[] = [
  [
    'read-only command by default: Seti has no read-only list, so it asks',
    manual,
    'Bash',
    sh('ls -la'),
    'allow',
    'tighter',
  ],
  ['read-only command in auto: Seti defers it', U, 'Bash', sh('git status'), 'allow', 'deferred'],
  [
    'deny inside sh -c: Seti matches scripts it can read, Claude Code does not',
    { ...U, rules: [['deny', 'Bash(curl *)']] },
    'Bash',
    sh("sh -c 'curl https://example.com'"),
    'classifier',
    'tighter',
  ],
]

describe.each([
  ['the e2e fake', E2E_FAKE],
  ['the test fixtures', FIXTURES],
  ["Claude Code's documentation", DOCUMENTED],
  ['known differences', KNOWN_DIFFERENCES],
])('replaying calls from %s', (_source, cases) => {
  it.each(cases.map((one) => ({ label: one[0], one })))('$label', ({ one }) => {
    const [, setup, tool, input, claude, expected = 'agree'] = one
    const decision = decideClaude(tool, input, setup)
    expect(compareOutcomes(decision, claude), JSON.stringify(decision)).toBe(expected)
  })
})

describe('comparing outcomes', () => {
  const at = (verdict: 'allow' | 'defer' | 'ask' | 'deny') =>
    ({ verdict, step: 'mode', rule: null, reason: '' }) as const

  it('calls Seti looser where it would let through what Claude Code stopped', () => {
    expect(compareOutcomes(at('allow'), 'ask')).toBe('looser')
    expect(compareOutcomes(at('defer'), 'deny')).toBe('looser')
    expect(compareOutcomes(at('ask'), 'deny')).toBe('looser')
  })

  it('calls Seti tighter where it would stop what Claude Code let through', () => {
    expect(compareOutcomes(at('deny'), 'allow')).toBe('tighter')
    expect(compareOutcomes(at('ask'), 'classifier')).toBe('tighter')
  })
})
