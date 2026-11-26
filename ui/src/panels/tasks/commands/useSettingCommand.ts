import {
  AGENT_SETTING_TABS,
  completeSetiLine,
  isSetiLine,
  parseSetiLine,
  SETI_NAMES,
  sourcesOf,
  type AgentSettingTab,
  type CommandWorld,
  type SetiCommand,
  type SetiCommandInput,
  type SetiCommandResult,
  type SetiCompletion,
} from '@seti/shared'
import { useState, type ReactElement } from 'react'
import { toast } from 'sonner'
import { apiPost, errorText } from '@/api'
import type { ConfirmOptions } from '@/components/ui/confirm-context'
import { noteAccessChange } from '@/panels/access/access'
import { useCredentialSwitch } from '@/panels/tasks/useCredentialSwitch'
import { questionFor } from './consequences'
import { typedHere } from './typed-here'
import type { CommandHost, SettingsTarget } from './types'
import { useCommandPalette } from './useCommandPalette'
import { useCommandWorld } from './useCommandWorld'

/** What the card above the reply box shows after Enter: why not, the settings' question, or Run. */
export type CommandCard =
  | { kind: 'refuse'; reason: string }
  | { kind: 'confirm'; question: ConfirmOptions; command: SetiCommand }
  | { kind: 'untrusted' }

export interface SettingCommand {
  line: string
  /** The choices for the word being typed; null while the name is typed or nothing fits. */
  completion: SetiCompletion | null
  card: CommandCard | null
  /** Takes the composer's Enter or Send; true, since the draft is a Seti command. */
  submit: (trusted: boolean) => boolean
  /** Puts a choice in place of the word being typed. */
  pick: (token: string) => void
  confirm: () => void
  /** Closes the card and leaves the draft as it is. */
  dismiss: () => boolean
}

/** The completion to show: none when the word typed is already the only choice, so Enter runs. */
function shownCompletion(draft: string, world: CommandWorld): SetiCompletion | null {
  if (!/\s/.test(draft.trimStart())) {
    return null
  }
  const completion = completeSetiLine(draft, world)
  const typed = draft.slice(completion?.from ?? draft.length).toLowerCase()
  const options = completion?.options ?? []
  const done = options.length === 1 && options[0]?.token.toLowerCase() === typed
  return completion === null || options.length === 0 || done ? null : completion
}

const isTab = (value: string | null | undefined): value is AgentSettingTab =>
  (AGENT_SETTING_TABS as readonly (string | null | undefined)[]).includes(value)

/** The tab or dialog a command that opens something opens. */
function openTarget(command: SetiCommand): SettingsTarget {
  const [name = '', word = ''] = command.keys
  if (name === 'settings') {
    return isTab(word) ? word : 'general'
  }
  const place = SETI_NAMES.find((entry) => entry.name === name)?.entry.place
  return name !== 'access' && isTab(place) ? place : 'access'
}

const opens = (command: SetiCommand) => {
  const found = SETI_NAMES.find((entry) => entry.name === command.keys[0])
  return found?.grammar.kind === 'open' || (command.keys[0] === 'access' && command.keys[1] === 'save')
}

const loading = (draft: string, world: CommandWorld) => sourcesOf(draft).some((source) => world[source] === null)

interface Run {
  draft: string
  world: CommandWorld
  host: CommandHost
  show: (card: CommandCard) => void
  done: () => void
  choose: ReturnType<typeof useCredentialSwitch>['choose']
}

async function post({ host, done }: Run, command: SetiCommand, confirmed: boolean) {
  try {
    const body: SetiCommandInput = { line: command.line, confirmed }
    const result = await apiPost<SetiCommandResult>(`/tasks/${host.task.id}/seti-commands`, body)
    toast.success(result.description)
    done()
    if (command.keys[0] === 'access' || command.keys[0] === 'mcp') {
      noteAccessChange(host.task.id)
    }
    host.onChanged()
  } catch (e) {
    toast.error(errorText(e))
  }
}

/** Reads the line and runs it, opens what it opens, or asks the settings' question first. */
function execute(run: Run) {
  const { draft, world, host, show, done } = run
  if (loading(draft, world)) {
    show({ kind: 'refuse', reason: "Loading the agent's settings; press Enter again" })
    return
  }
  const parsed = parseSetiLine(draft, world)
  if (!parsed.ok) {
    show({ kind: 'refuse', reason: parsed.reason })
    return
  }
  const { command } = parsed
  if (opens(command)) {
    host.openSettings(openTarget(command))
    done()
  } else if (command.keys[0] === 'access' && command.keys[1] === 'credential') {
    const id = command.keys[2] ?? ''
    run.choose(
      id,
      world.credentials?.find((profile) => profile.id === id),
    )
    done()
  } else if (command.rule.confirm) {
    show({ kind: 'confirm', question: questionFor(command, host.task, host.running, world.caps), command })
  } else {
    void post(run, command, false)
  }
}

/**
 * Runs the Seti command in the composer's draft: completes each word from the agent's state, and
 * on Enter sends the line to Seti, which reads it again and runs it through the settings' own
 * functions. Only a line the user typed here runs at Enter; any other asks first. The credential
 * dialog it may open is returned beside it, since it outlives the draft.
 */
export function useSettingCommand(
  host: CommandHost,
  draft: string,
  typed: string | null,
  setDraft: (draft: string, typed: boolean) => void,
): [SettingCommand | null, ReactElement | null] {
  const active = isSetiLine(draft)
  const world = useCommandWorld(host.task, draft, active)
  const credential = useCredentialSwitch(host.task, host.onChanged)
  const [card, setCard] = useState<{ draft: string; card: CommandCard } | null>(null)
  useCommandPalette(host.task, (text) => {
    setDraft(text, true)
  })
  if (!active) {
    return [null, credential.dialog]
  }
  const run: Run = {
    draft,
    world,
    host,
    choose: credential.choose,
    show: (shown) => {
      setCard({ draft, card: shown })
    },
    done: () => {
      setCard(null)
      setDraft('', true)
    },
  }
  const current = card?.draft === draft ? card.card : null
  const command: SettingCommand = {
    line: draft,
    completion: shownCompletion(draft, world),
    card: current,
    submit: (trusted) => {
      if (typedHere(trusted, typed, draft)) {
        execute(run)
      } else {
        run.show({ kind: 'untrusted' })
      }
      return true
    },
    pick: (token) => {
      const from = completeSetiLine(draft, world)?.from ?? draft.length
      setDraft(`${draft.slice(0, from)}${token} `, true)
    },
    confirm: () => {
      if (current?.kind === 'untrusted') {
        execute(run)
      } else if (current?.kind === 'confirm') {
        void post(run, current.command, true)
      }
    },
    dismiss: () => {
      setCard(null)
      return current !== null
    },
  }
  return [command, credential.dialog]
}
