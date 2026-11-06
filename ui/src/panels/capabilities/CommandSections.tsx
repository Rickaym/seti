import type { CommandGroup, CommandInfo, ModelEntry, SubagentInfo } from '@seti/shared'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { cn } from '@/lib/utils'
import { EmptyRow } from './Section'

const GROUP_OPEN_LIMIT = 15

const NAME_COLUMNS = {
  wide: 'grid-cols-[minmax(0,20rem)_minmax(0,1fr)] max-md:grid-cols-1',
  narrow: 'grid-cols-[minmax(0,13rem)_minmax(0,1fr)] max-md:grid-cols-1',
}

function NameRow({
  name,
  meta,
  description,
  width = 'wide',
}: {
  name: string
  meta: string
  description: string
  width?: keyof typeof NAME_COLUMNS
}) {
  return (
    <li className={cn('grid gap-x-4 border-b border-border px-3 py-1.5 last:border-b-0', NAME_COLUMNS[width])}>
      <div className="min-w-0">
        <div className="font-medium break-words">{name}</div>
        {meta !== '' && <div className="text-2xs break-words text-muted-foreground">{meta}</div>}
      </div>
      <p className="line-clamp-2 text-muted-foreground" title={description}>
        {description === '' ? '-' : description}
      </p>
    </li>
  )
}

function commandMeta(command: CommandInfo): string {
  const aliases = command.aliases.map((alias) => `/${alias}`).join(' ')
  return [command.argument_hint, aliases === '' ? '' : `aka ${aliases}`].filter((part) => part !== '').join('  ')
}

export function CommandList({ commands }: { commands: CommandInfo[] }) {
  if (commands.length === 0) {
    return <EmptyRow>No matching commands.</EmptyRow>
  }
  return (
    <ul>
      {commands.map((command) => (
        <NameRow
          key={command.name}
          name={`/${command.name}`}
          meta={commandMeta(command)}
          description={command.description}
        />
      ))}
    </ul>
  )
}

function Group({ group, forceOpen }: { group: CommandGroup; forceOpen: boolean }) {
  const [open, setOpen] = useState(group.commands.length <= GROUP_OPEN_LIMIT)
  const shown = open || forceOpen
  const Chevron = shown ? ChevronDown : ChevronRight
  return (
    <div className="border-b border-border last:border-b-0">
      <button
        type="button"
        aria-expanded={shown}
        className="flex w-full items-center gap-1.5 bg-muted/40 px-3 py-1.5 text-left font-semibold hover:bg-accent"
        onClick={() => {
          setOpen(!shown)
        }}
      >
        <Chevron className="size-3.5 text-muted-foreground" />
        {group.prefix ?? 'Standalone skills'}
        <span className="font-normal text-muted-foreground">{group.commands.length}</span>
      </button>
      {shown && <CommandList commands={group.commands} />}
    </div>
  )
}

export function SkillGroups({ groups, forceOpen }: { groups: CommandGroup[]; forceOpen: boolean }) {
  if (groups.length === 0) {
    return <EmptyRow>No matching skills.</EmptyRow>
  }
  return (
    <div>
      {groups.map((group) => (
        <Group key={group.prefix ?? ''} group={group} forceOpen={forceOpen} />
      ))}
    </div>
  )
}

export function SubagentList({ agents }: { agents: SubagentInfo[] }) {
  if (agents.length === 0) {
    return <EmptyRow>No matching subagents.</EmptyRow>
  }
  return (
    <ul>
      {agents.map((agent) => (
        <NameRow
          key={agent.name}
          name={agent.name}
          meta={agent.model ?? 'default model'}
          description={agent.description}
          width="narrow"
        />
      ))}
    </ul>
  )
}

export function ModelList({ models }: { models: ModelEntry[] }) {
  if (models.length === 0) {
    return <EmptyRow>No matching models.</EmptyRow>
  }
  return (
    <ul>
      {models.map((model) => (
        <NameRow
          key={model.value}
          name={model.display_name}
          meta={model.value}
          description={model.description}
          width="narrow"
        />
      ))}
    </ul>
  )
}
