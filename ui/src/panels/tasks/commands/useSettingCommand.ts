import { meetsNeeds, parseSettingCommand, type SettingCommandLine } from '@seti/shared'
import { useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react'
import { toast } from 'sonner'
import { errorText } from '@/api'
import { useCapabilities } from '@/hooks/useCapabilities'
import { useSystem } from '@/hooks/useSystem'
import { useCredentialSwitch } from '@/panels/tasks/useCredentialSwitch'
import { COMMAND_BINDINGS } from './bindings'
import { typedHere } from './typed-here'
import type { Choice, CommandContext, CommandHost, CommandStep, Stepper } from './types'
import { useCommandPalette } from './useCommandPalette'

/**
 * What the composer shows for a setting command: `live` offers choices while the words are typed,
 * `submitted` the step after Enter, `untrusted` asks before running a line that was not typed.
 */
type CardPhase = 'live' | 'submitted' | 'untrusted'

export interface SettingCommand {
  line: SettingCommandLine
  step: CommandStep | null
  /** The card to show now, or null. */
  phase: CardPhase | null
  error: string | null
  /** Takes the composer's Enter or Send; false when the draft is not a setting command. */
  submit: (trusted: boolean) => boolean
  choose: (choice: Choice) => void
  confirm: () => void
  /** Closes the card and leaves the draft as it is. */
  dismiss: () => boolean
  dialog: ReactElement | null
}

interface Loaded {
  key: string
  stepper: Stepper | null
  error: string | null
}

const keyOf = (line: SettingCommandLine | null, taskId: string, version: string) =>
  line === null ? null : `${taskId}:${line.setting.id}:${version}`

/** Loads what the typed command reads, once per command and agent state, not per keystroke. */
function useStepper(line: SettingCommandLine | null, context: CommandContext): Loaded | null {
  const key = keyOf(line, context.task.id, context.task.updated_at)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const latest = useRef({ context, line })
  useLayoutEffect(() => {
    latest.current = { context, line }
  })
  useEffect(() => {
    const { line: now, context: at } = latest.current
    const bind = now === null ? undefined : COMMAND_BINDINGS.get(now.setting.id)
    if (key === null || bind === undefined) {
      return undefined
    }
    let stale = false
    bind(at).then(
      (stepper) => {
        if (!stale) {
          setLoaded({ key, stepper, error: null })
        }
      },
      (e: unknown) => {
        if (!stale) {
          setLoaded({ key, stepper: null, error: errorText(e) })
        }
      },
    )
    return () => {
      stale = true
    }
  }, [key])
  return loaded !== null && loaded.key === key ? loaded : null
}

/** The step the words lead to, or a refusal when the agent's runtime lacks what the command needs. */
function stepOf(line: SettingCommandLine, context: CommandContext, loaded: Loaded | null): CommandStep | null {
  if (!meetsNeeds(context.caps, line.setting.needs)) {
    return { kind: 'refuse', reason: `/${line.setting.command.name} is not on ${context.caps?.label ?? ''} agents` }
  }
  return loaded?.stepper?.(line.args) ?? null
}

/**
 * Runs the setting command in the composer's draft through the cog's own actions. Only a line the
 * user typed here runs at Enter; any other asks first, so text from elsewhere never acts.
 */
export function useSettingCommand(
  host: CommandHost,
  draft: string,
  typed: string | null,
  setDraft: (draft: string, typed: boolean) => void,
): SettingCommand | null {
  const caps = useCapabilities(host.task)
  const sandboxOn = useSystem().data?.sandbox.enabled ?? false
  const credential = useCredentialSwitch(host.task, host.onChanged)
  const context: CommandContext = { ...host, caps, sandboxOn, switchCredential: credential.choose }
  const line = parseSettingCommand(draft)
  const loaded = useStepper(line, context)
  const [phase, setPhase] = useState<{ draft: string; phase: CardPhase | null }>({ draft, phase: 'live' })
  const current = phase.draft === draft ? phase.phase : 'live'
  const settle = (target: CommandStep | null, at: string) => {
    if (target?.kind === 'run') {
      setPhase({ draft: at, phase: null })
      void target.run().then((ok) => {
        if (ok) {
          setDraft('', true)
        }
      })
      return
    }
    setPhase({ draft: at, phase: 'submitted' })
  }
  useCommandPalette(host.task, (text) => {
    setDraft(text, true)
    const picked = parseSettingCommand(text)
    const bind = picked === null ? undefined : COMMAND_BINDINGS.get(picked.setting.id)
    if (picked === null || bind === undefined) {
      return
    }
    bind(context).then(
      (stepper) => {
        settle(stepOf(picked, context, { key: text, stepper, error: null }), text)
      },
      (e: unknown) => toast.error(errorText(e)),
    )
  })
  if (line === null) {
    return null
  }
  const step = stepOf(line, context, loaded)
  const name = line.setting.command.name
  const typingName = !/\s/.test(draft.trimStart())
  return {
    line,
    step,
    phase: current === 'live' && typingName ? null : current,
    error: loaded?.error ?? null,
    submit: (trusted) => {
      if (typedHere(trusted, typed, draft)) {
        settle(step, draft)
      } else {
        setPhase({ draft, phase: 'untrusted' })
      }
      return true
    },
    choose: (picked) => {
      const text = `/${name} ${picked.args}`
      setDraft(text, true)
      settle(loaded?.stepper?.(picked.args) ?? null, text)
    },
    confirm: () => {
      if (current === 'untrusted') {
        settle(step, draft)
      } else if (step?.kind === 'confirm') {
        settle({ kind: 'run', run: step.run }, draft)
      }
    },
    dismiss: () => {
      const open = current === 'submitted' || current === 'untrusted'
      setPhase({ draft, phase: null })
      return open
    },
    dialog: credential.dialog,
  }
}
