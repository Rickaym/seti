import { AGENT_SETTING_TABS } from '@seti/shared'
import { toast } from 'sonner'
import { errorText } from '@/api'
import { renameTask } from '@/panels/tasks/rename'
import { archiveQuestion, archiveTask } from '@/panels/tasks/useArchive'
import { startDream } from '@/panels/tasks/useDreams'
import { restartQuestion, restartTask } from '@/panels/tasks/useSessionRestart'
import { bypassBinding, credentialBinding, sandboxBinding } from './access-bindings'
import { choice, pick, refuse, runStep } from './choices'
import { mcpBinding } from './mcp-binding'
import type { CommandBinding, CommandContext, Stepper } from './types'

/** A command that needs nothing loaded before its steps. */
const instant =
  (steps: (context: CommandContext) => Stepper): CommandBinding =>
  async (context) =>
    Promise.resolve(steps(context))

const TAB_LABELS = { general: 'General', access: 'Access', team: 'Team', session: 'Session' } as const

const restart = instant((context) => () => ({
  kind: 'confirm',
  question: restartQuestion(context.task, context.running, context.caps),
  run: async () => restartTask(context.task, context.running, context.onChanged),
}))

const archive = instant(
  (context) => () =>
    context.busy
      ? refuse('Stop the agent to archive it')
      : { kind: 'confirm', question: archiveQuestion(context.task), run: async () => archiveTask(context.task) },
)

const dream = instant(
  (context) => () =>
    runStep(async () => {
      try {
        await startDream(context.task.id)
        toast.success(`"${context.task.title}" dreams now; its changes show under Dreams in its settings`)
        return true
      } catch (e) {
        toast.error(errorText(e))
        return false
      }
    }),
)

const rename = instant((context) => (args) => {
  const title = args.trim()
  if (title === '') {
    return runStep(async () => {
      context.startRename()
      return Promise.resolve(true)
    })
  }
  return runStep(async () =>
    title === context.task.title ? Promise.resolve(true) : renameTask(context.task, title, context.onChanged),
  )
})

const open = (context: CommandContext, target: Parameters<CommandContext['openSettings']>[0]) =>
  runStep(async () => {
    context.openSettings(target)
    return Promise.resolve(true)
  })

const access = instant((context) => () => open(context, 'access'))

const settings = instant((context) => (args) => {
  if (args.trim() === '') {
    return open(context, 'general')
  }
  const tabs = AGENT_SETTING_TABS.map((tab) => choice(tab, TAB_LABELS[tab]))
  return pick('Open which tab?', tabs, args, (tab) =>
    open(context, AGENT_SETTING_TABS.find((entry) => entry === tab.args) ?? 'general'),
  )
})

/** Each setting command's binding, by the setting's id in the registry. */
export const COMMAND_BINDINGS: ReadonlyMap<string, CommandBinding> = new Map([
  ['restart', restart],
  ['archive', archive],
  ['dream', dream],
  ['rename', rename],
  ['access', access],
  ['settings', settings],
  ['sandbox', sandboxBinding],
  ['bypass', bypassBinding],
  ['credential', credentialBinding],
  ['mcp', mcpBinding],
])
