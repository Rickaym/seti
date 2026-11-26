import type { AccessItem, TaskAccessInput, TaskAccessView } from '@seti/shared'
import { toast } from 'sonner'
import { apiGet, apiPut, errorText } from '@/api'
import { noteAccessChange } from '@/panels/access/access'
import { choice, pick, refuse, runStep, splitFirst } from './choices'
import type { CommandBinding, CommandContext, CommandStep } from './types'

const stateWord = (item: AccessItem) => `${item.enabled ? 'On' : 'Off'}${item.override === null ? ', default' : ''}`

const STATES: Readonly<Record<string, boolean | null>> = { on: true, off: false, default: null }

const stateLine = (enabled: boolean | null) => {
  if (enabled === null) {
    return 'follows its default'
  }
  return enabled ? 'on' : 'off'
}

async function setServer(context: CommandContext, item: AccessItem, enabled: boolean | null): Promise<boolean> {
  try {
    const body: TaskAccessInput = { kind: 'mcp', id: item.id, enabled }
    await apiPut<TaskAccessView>(`/tasks/${context.task.id}/access`, body)
    noteAccessChange(context.task.id)
    toast.success(`MCP server ${item.name} ${stateLine(enabled)}; applies from the next turn`)
    context.onChanged()
    return true
  } catch (e) {
    toast.error(errorText(e))
    return false
  }
}

function serverSteps(context: CommandContext, item: AccessItem, typed: string): CommandStep {
  const states = [
    choice(`${item.name} on`, 'On', item.override === true),
    choice(`${item.name} off`, 'Off', item.override === false),
    choice(`${item.name} default`, 'Default', item.override === null, item.default_enabled ? 'on' : 'off'),
  ]
  const typedState = typed === '' ? '' : `${item.name} ${typed}`
  return pick(item.name, states, typedState, (picked) => {
    const word = splitFirst(picked.args.slice(item.name.length))[0]
    const enabled = STATES[word] ?? null
    return runStep(async () => setServer(context, item, enabled))
  })
}

/** Lists the agent's MCP servers with their state; a server and on, off or default sets it. */
export const mcpBinding: CommandBinding = async (context) => {
  const view = await apiGet<TaskAccessView>(`/tasks/${context.task.id}/access`)
  const servers = view.items.filter((item) => item.kind === 'mcp' && item.unusable === null)
  const choices = servers.map((item) => choice(item.name, item.name, false, stateWord(item)))
  return (args) => {
    if (servers.length === 0) {
      return refuse('No MCP servers to choose from; add them in Settings, MCP servers')
    }
    const [name, state] = splitFirst(args)
    return pick('MCP servers', choices, name, (picked) => {
      const item = servers.find((server) => server.name === picked.args)
      return item === undefined ? refuse(`No MCP server ${name}`) : serverSteps(context, item, state)
    })
  }
}
