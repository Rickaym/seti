import { BYPASS_HOURS, bypassOn, type BypassHours, type ProfileSummary } from '@seti/shared'
import { FastForward, ShieldOff } from 'lucide-react'
import { apiGet } from '@/api'
import { BYPASS_DETAIL, SANDBOX_HINT, SANDBOX_RESTARTS, saveBypass, saveSandbox } from '@/panels/tasks/setting-actions'
import { choice, pick, refuse, runStep } from './choices'
import type { CommandBinding, CommandContext, Stepper } from './types'

const sandboxSteps =
  (context: CommandContext): Stepper =>
  (args) => {
    const { task, running, onChanged } = context
    if (!context.sandboxOn) {
      return refuse('The sandbox is off in Settings, so this agent runs outside it')
    }
    const choices = [choice('on', 'On', task.sandbox), choice('off', 'Off', !task.sandbox)]
    return pick('Sandbox', choices, args, ({ args: value }) => {
      const sandbox = value === 'on'
      if (sandbox === task.sandbox) {
        return refuse(`The sandbox is already ${value}`)
      }
      const run = async () => saveSandbox(task, sandbox, running, onChanged)
      return sandbox
        ? runStep(run)
        : {
            kind: 'confirm',
            question: {
              title: 'Turn the sandbox off',
              message: SANDBOX_HINT.off,
              detail: SANDBOX_RESTARTS,
              confirmLabel: 'Turn off',
              variant: 'destructive',
              icon: ShieldOff,
            },
            run,
          }
    })
  }

export const sandboxBinding: CommandBinding = async (context) => Promise.resolve(sandboxSteps(context))

const hoursOf = (value: string): BypassHours | null => BYPASS_HOURS.find((hours) => String(hours) === value) ?? null

const bypassSteps =
  (context: CommandContext): Stepper =>
  (args) => {
    const { task, onChanged } = context
    const on = bypassOn(task.bypass_until)
    const choices = [
      ...BYPASS_HOURS.map((hours) => choice(String(hours), `${String(hours)} h`)),
      choice('off', 'Off', !on),
    ]
    return pick('Bypass for how long?', choices, args, ({ args: value }) => {
      const hours = hoursOf(value)
      if (hours === null) {
        return on ? runStep(async () => saveBypass(task, null, onChanged)) : refuse('Bypass is already off')
      }
      return {
        kind: 'confirm',
        question: {
          title: 'Turn Bypass on',
          message: `"${task.title}" runs every tool without asking for ${String(hours)} hours.`,
          detail: BYPASS_DETAIL,
          confirmLabel: 'Turn on',
          icon: FastForward,
        },
        run: async () => saveBypass(task, hours, onChanged),
      }
    })
  }

export const bypassBinding: CommandBinding = async (context) => Promise.resolve(bypassSteps(context))

/** Lists the credentials; picking one switches as the Credentials row does, with its dialog. */
export const credentialBinding: CommandBinding = async (context) => {
  const profiles = await apiGet<ProfileSummary[]>('/credential-profiles')
  const choices = profiles.map((profile) => choice(profile.id, profile.name, profile.id === context.task.profile_id))
  return (args) =>
    pick('Which credential?', choices, args, ({ args: id }) =>
      id === context.task.profile_id
        ? refuse('This agent uses that credential already')
        : runStep(async () => {
            context.switchCredential(
              id,
              profiles.find((profile) => profile.id === id),
            )
            return Promise.resolve(true)
          }),
    )
}
