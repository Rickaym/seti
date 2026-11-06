import fs from 'node:fs'

/** What the fake gh answers, as the spec last wrote it to SETI_E2E_GH_STATE. */
interface FakeGhState {
  viewer: string
  /** GraphQL PullRequest nodes by PR URL. */
  prs: Record<string, unknown>
  /** The open PR nodes of each repo by slug, as the repo PR list query reads them. */
  repos?: Record<string, unknown[]>
}

function readState(): FakeGhState {
  try {
    return JSON.parse(fs.readFileSync(process.env.SETI_E2E_GH_STATE ?? '', 'utf8')) as FakeGhState
  } catch {
    return { viewer: 'e2e', prs: {} }
  }
}

/** The `-f name=value` fields of a gh call. */
function fields(args: readonly string[]): Map<string, string> {
  const found = new Map<string, string>()
  args.forEach((arg, index) => {
    const value = args[index + 1]
    if (arg === '-f' && value !== undefined) {
      const at = value.indexOf('=')
      found.set(value.slice(0, at), value.slice(at + 1))
    }
  })
  return found
}

function answer(args: readonly string[]): string | null {
  const state = readState()
  if (args[0] !== 'api') {
    return null
  }
  if (args[1] === 'user') {
    return `${state.viewer}\n`
  }
  if (args[1] === 'rate_limit') {
    return JSON.stringify({ remaining: 5000, reset: Math.floor(Date.now() / 1000) + 3600 })
  }
  if (args[1] !== 'graphql') {
    return null
  }
  const given = fields(args)
  const owner = given.get('owner')
  if (owner !== undefined) {
    const nodes = state.repos?.[`${owner}/${given.get('name') ?? ''}`] ?? []
    return JSON.stringify({ data: { repository: { pullRequests: { nodes } } } })
  }
  const urls = [...given].filter(([name]) => /^u\d+$/.test(name))
  const data = Object.fromEntries(urls.map(([name, url]) => [`p${name.slice(1)}`, state.prs[url] ?? null]))
  return JSON.stringify({ data })
}

const args = process.argv.slice(2)
const output = answer(args)
if (output === null) {
  process.stderr.write(`the fake gh cannot answer: gh ${args.join(' ')}\n`)
  process.exitCode = 1
} else {
  process.stdout.write(output)
}
