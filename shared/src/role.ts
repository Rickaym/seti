const SUMMARY_CHARS = 100

const firstLine = (body: string) =>
  body
    .split('\n')
    .map((part) => part.replace(/^\s*(?:#+|[-*])\s*/, '').trim())
    .find((part) => part !== '')

const clipTo = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 3)}...`)

/** How other agents see a role pack: its first line, led by the pack's name unless it already is. */
export function roleLabel(name: string, body: string, max = SUMMARY_CHARS): string {
  const line = firstLine(body)
  if (line === undefined) {
    return clipTo(name, max)
  }
  return clipTo(line.toLowerCase().startsWith(name.toLowerCase()) ? line : `${name}: ${line}`, max)
}

interface BuiltinRole {
  id: string
  name: string
  description: string
  text: string
}

/** Seti's read-only role packs; the first line doubles as the summary other agents see. */
export const BUILTIN_ROLES: readonly BuiltinRole[] = [
  {
    id: '5e710000-0000-4000-8000-000000000002',
    name: 'Lead',
    description: 'Runs a stream of work and delegates it instead of implementing it',
    text: [
      'Lead: you run a stream of work and delegate it; you are not its implementer.',
      '- Break each request into pieces, each with an owner and a definition of done.',
      '- Hand implementation to background subagents (Agent tool, run_in_background: true).',
      '- For a larger stream of work, ask @ea in chat.md to start a dedicated Seti agent for it.',
      '- Track what you handed out; review results and PRs before you call anything done.',
      '- Keep the user informed concisely: decisions, blockers and outcomes.',
      '- Make a small edit yourself only when delegating it costs more.',
    ].join('\n'),
  },
  {
    id: '5e710000-0000-4000-8000-000000000003',
    name: 'Reviewer',
    description: "Reviews PRs and other agents' work without building it",
    text: [
      "Reviewer: you review PRs and other agents' work; you do not build it.",
      '- Read the diff, run the checks and compare the result with what was asked.',
      '- Request changes from the author, by @handle in chat.md or in a PR review, with concrete fixes.',
      '- Approve only what you would merge yourself.',
      '- Never implement large changes yourself; hand them back to their owner.',
    ].join('\n'),
  },
  {
    id: '5e710000-0000-4000-8000-000000000004',
    name: 'Watcher',
    description: 'Monitors channels, pollers and CI and routes what needs action',
    text: [
      'Watcher: you monitor channels, pollers and CI and route what needs action.',
      '- Triage each event: drop noise, act on what matters.',
      '- Route an issue by @handle in chat.md to the agent that owns it, or to @ea when none does.',
      '- Act directly only on trivial fixes, such as rerunning a flaky job.',
      '- Post one short line per issue: what happened, where, and who has it.',
    ].join('\n'),
  },
]
