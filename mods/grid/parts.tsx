import type { UiModApi } from '@seti/mod-api'
import type { ComponentProps } from 'react'
import { seti } from './seti'

type Kit = UiModApi['kit']
type Agents = UiModApi['agents']
type Terminals = UiModApi['terminals']

export function Button(props: ComponentProps<Kit['Button']>) {
  const Part = seti().kit.Button
  return <Part {...props} />
}

export function Hint(props: ComponentProps<Kit['Hint']>) {
  const Part = seti().kit.Hint
  return <Part {...props} />
}

export function ToggleButton(props: ComponentProps<Kit['ToggleButton']>) {
  const Part = seti().kit.ToggleButton
  return <Part {...props} />
}

export function DropdownMenu(props: ComponentProps<Kit['DropdownMenu']['Root']>) {
  const Part = seti().kit.DropdownMenu.Root
  return <Part {...props} />
}

export function DropdownMenuTrigger(props: ComponentProps<Kit['DropdownMenu']['Trigger']>) {
  const Part = seti().kit.DropdownMenu.Trigger
  return <Part {...props} />
}

export function DropdownMenuContent(props: ComponentProps<Kit['DropdownMenu']['Content']>) {
  const Part = seti().kit.DropdownMenu.Content
  return <Part {...props} />
}

export function DropdownMenuItem(props: ComponentProps<Kit['DropdownMenu']['Item']>) {
  const Part = seti().kit.DropdownMenu.Item
  return <Part {...props} />
}

export function DropdownMenuRadioGroup(props: ComponentProps<Kit['DropdownMenu']['RadioGroup']>) {
  const Part = seti().kit.DropdownMenu.RadioGroup
  return <Part {...props} />
}

export function DropdownMenuRadioItem(props: ComponentProps<Kit['DropdownMenu']['RadioItem']>) {
  const Part = seti().kit.DropdownMenu.RadioItem
  return <Part {...props} />
}

export function Command(props: ComponentProps<Kit['Command']['Root']>) {
  const Part = seti().kit.Command.Root
  return <Part {...props} />
}

export function CommandInput(props: ComponentProps<Kit['Command']['Input']>) {
  const Part = seti().kit.Command.Input
  return <Part {...props} />
}

export function CommandList(props: ComponentProps<Kit['Command']['List']>) {
  const Part = seti().kit.Command.List
  return <Part {...props} />
}

export function CommandItem(props: ComponentProps<Kit['Command']['Item']>) {
  const Part = seti().kit.Command.Item
  return <Part {...props} />
}

export function CommandEmpty(props: ComponentProps<Kit['Command']['Empty']>) {
  const Part = seti().kit.Command.Empty
  return <Part {...props} />
}

export function StatusLight(props: ComponentProps<Agents['StatusLight']>) {
  const Part = seti().agents.StatusLight
  return <Part {...props} />
}

export function UnseenDot() {
  const Part = seti().agents.UnseenDot
  return <Part />
}

export function AgentFrame(props: ComponentProps<Agents['Frame']>) {
  const Part = seti().agents.Frame
  return <Part {...props} />
}

/** One agent or subagent behind an error boundary. */
export function AgentView(props: ComponentProps<Agents['View']>) {
  const Part = seti().agents.View
  return <Part {...props} />
}

export function FilesDockHost(props: ComponentProps<Agents['FilesDockHost']>) {
  const Part = seti().agents.FilesDockHost
  return <Part {...props} />
}

export function TerminalView(props: ComponentProps<Terminals['View']>) {
  const Part = seti().terminals.View
  return <Part {...props} />
}

export function TerminalName(props: ComponentProps<Terminals['Name']>) {
  const Part = seti().terminals.Name
  return <Part {...props} />
}
