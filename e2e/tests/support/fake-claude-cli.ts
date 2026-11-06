import fs from 'node:fs'
import path from 'node:path'

/** A plugin a fake marketplace offers. */
interface FakePlugin {
  name: string
  description: string
  version: string
  skills: string[]
}

interface FakeMarketplace {
  name: string
  repo: string
  plugins: FakePlugin[]
}

interface FakeInstall {
  id: string
  version: string
  scope: string
  enabled: boolean
}

/** What the fake claude knows: sources it can add, what is added and what is installed. */
interface FakeState {
  sources: Record<string, FakeMarketplace>
  marketplaces: FakeMarketplace[]
  installed: FakeInstall[]
}

const stateFile = process.env.SETI_E2E_CLAUDE_STATE ?? ''
const dir = path.dirname(stateFile)

const readState = (): FakeState => JSON.parse(fs.readFileSync(stateFile, 'utf8')) as FakeState

function writeState(state: FakeState): void {
  const next = `${stateFile}.next`
  fs.writeFileSync(next, JSON.stringify(state))
  fs.renameSync(next, stateFile)
}

/** A checkout with a marketplace.json, so Seti can read what each plugin declares. */
function checkout(marketplace: FakeMarketplace): string {
  const root = path.join(dir, 'marketplaces', marketplace.name)
  fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true })
  const plugins = marketplace.plugins.map((plugin) => ({
    name: plugin.name,
    description: plugin.description,
    version: plugin.version,
    source: { source: 'url', url: `https://example.com/${plugin.name}.git` },
    skills: plugin.skills.map((skill) => `./skills/${skill}`),
  }))
  fs.writeFileSync(
    path.join(root, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({ name: marketplace.name, plugins }),
  )
  return root
}

const pluginOf = (state: FakeState, id: string) => {
  const [name, market] = id.split('@')
  return state.marketplaces.find((entry) => entry.name === market)?.plugins.find((plugin) => plugin.name === name)
}

const ok = (message: string) => `${JSON.stringify({ outcome: 'ok', message })}\n`

function removeWhere<T>(items: T[], drop: (item: T) => boolean): void {
  const index = items.findIndex(drop)
  if (index >= 0) {
    items.splice(index, 1)
  }
}

function change(state: FakeState, verb: string, target: string): string {
  const installed = state.installed.find((entry) => entry.id === target)
  switch (verb) {
    case 'install': {
      const plugin = pluginOf(state, target)
      if (plugin === undefined) {
        throw new Error(`Plugin "${target}" not found`)
      }
      state.installed.push({ id: target, version: plugin.version, scope: 'user', enabled: true })
      return ok(`Successfully installed plugin: ${target} (scope: user)`)
    }
    case 'uninstall':
      removeWhere(state.installed, (entry) => entry.id === target)
      return ok(`Successfully uninstalled plugin: ${target}`)
    case 'enable':
    case 'disable':
      if (installed !== undefined) {
        installed.enabled = verb === 'enable'
      }
      return ok(`Successfully ${verb}d plugin: ${target}`)
    default:
      return ok(`Plugin ${target} is up to date`)
  }
}

function marketplaceChange(state: FakeState, verb: string, target: string): string {
  if (verb === 'add') {
    const added = state.sources[target]
    if (added === undefined) {
      throw new Error(`Failed to clone marketplace repository: ${target}`)
    }
    state.marketplaces.push(added)
    return ok(`Successfully added marketplace: ${added.name}`)
  }
  if (verb === 'remove') {
    removeWhere(state.marketplaces, (entry) => entry.name === target)
    return ok(`Successfully removed marketplace: ${target}`)
  }
  return ok(`Successfully updated marketplace: ${target}`)
}

function details(state: FakeState, id: string): string {
  const skills = pluginOf(state, id)?.skills ?? []
  const names = skills.join(', ')
  return `${id}\n\nComponent inventory\n  Skills (${String(skills.length)})  ${names}\n  Agents (0)\n`
}

function answer(args: readonly string[], state: FakeState): string {
  const words = args.filter((arg) => !arg.startsWith('-'))
  const target = args[args.indexOf('--') + 1] ?? ''
  const command = words.slice(0, 3).join(' ')
  if (command.startsWith('plugin list') && args.includes('--available')) {
    const ids = new Set(state.installed.map((entry) => entry.id))
    const available = state.marketplaces.flatMap((market) =>
      market.plugins
        .map((plugin) => ({ ...plugin, pluginId: `${plugin.name}@${market.name}`, marketplaceName: market.name }))
        .filter((plugin) => !ids.has(plugin.pluginId)),
    )
    return JSON.stringify({ installed: state.installed, available })
  }
  if (command.startsWith('plugin list')) {
    return JSON.stringify(state.installed)
  }
  if (command === 'plugin marketplace list') {
    const listed = state.marketplaces.map((market) => ({
      name: market.name,
      source: 'github',
      repo: market.repo,
      installLocation: checkout(market),
    }))
    return JSON.stringify(listed)
  }
  if (command.startsWith('plugin details')) {
    return details(state, target)
  }
  if (words[1] === 'marketplace') {
    return marketplaceChange(state, words[2] ?? '', target)
  }
  return change(state, words[1] ?? '', target)
}

const args = process.argv.slice(2)
const reads = args.includes('list') || args.includes('details')
fs.appendFileSync(path.join(dir, 'calls.log'), `${JSON.stringify(args)}\n`)
try {
  const state = readState()
  const output = answer(args, state)
  if (!reads) {
    writeState(state)
  }
  process.stdout.write(output)
} catch (e) {
  const message = e instanceof Error ? e.message : String(e)
  process.stdout.write(`${JSON.stringify({ outcome: 'failed', message })}\n`)
  process.stderr.write(`Failed: ${message}\n`)
  process.exitCode = 1
}
