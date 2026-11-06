import type { ContextFile, ContextPack, RevisionObjectType } from '@seti/shared'
import { Plus } from 'lucide-react'
import type { ReactNode } from 'react'
import { AgentChangedMark } from '@/components/AgentChangedMark'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { NEW_PACK, NEW_ROLE, packSelection } from '@/panels/context/selection'

function SectionHeader({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="flex h-9 items-center justify-between border-b border-border px-3">
      <span className="text-2xs font-semibold tracking-wider text-muted-foreground uppercase">{title}</span>
      {action}
    </div>
  )
}

function Item({
  selected,
  onSelect,
  title,
  detail,
  muted = false,
  agentChanged,
}: {
  selected: boolean
  onSelect: () => void
  title: string
  detail: string
  muted?: boolean
  agentChanged: boolean
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn('block w-full border-b border-border px-3 py-2 text-left hover:bg-accent', selected && 'bg-accent')}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <span className={cn('min-w-0 truncate text-sm font-medium', muted && 'text-muted-foreground')}>{title}</span>
        {agentChanged && <AgentChangedMark />}
      </div>
      <div className="mt-0.5 truncate text-2xs text-muted-foreground">{detail}</div>
    </button>
  )
}

function packDetail(pack: ContextPack): string {
  const about = pack.description === '' ? `${pack.body.length.toLocaleString()} chars` : pack.description
  const tags = [pack.builtin ? 'Built in' : null, pack.linked_by_default ? 'Default' : null].filter(
    (tag) => tag !== null,
  )
  return tags.length === 0 ? about : `${tags.join(', ')}: ${about}`
}

const builtinFirst = (packs: readonly ContextPack[]) => packs.toSorted((a, b) => Number(b.builtin) - Number(a.builtin))

function NewButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Hint text={label}>
      <Button size="icon-xs" variant="ghost" aria-label={label} onClick={onClick}>
        <Plus />
      </Button>
    </Hint>
  )
}

function PackItems({
  packs,
  selected,
  onSelect,
  agentChanged,
}: {
  packs: readonly ContextPack[]
  selected: string
  onSelect: (selection: string) => void
  agentChanged: (type: RevisionObjectType, id: string) => boolean
}) {
  return builtinFirst(packs).map((pack) => (
    <Item
      key={pack.id}
      selected={selected === packSelection(pack.id)}
      onSelect={() => {
        onSelect(packSelection(pack.id))
      }}
      title={pack.name}
      detail={packDetail(pack)}
      agentChanged={agentChanged('context_pack', pack.id)}
    />
  ))
}

const sizeText = (file: ContextFile) =>
  file.exists && file.size !== null ? `${file.size.toLocaleString()} bytes` : 'not created'

function groupFiles(files: readonly ContextFile[]): [string, ContextFile[]][] {
  const groups = new Map<string, ContextFile[]>()
  for (const file of files) {
    groups.set(file.group, [...(groups.get(file.group) ?? []), file])
  }
  return [...groups.entries()]
}

export function ContextList({
  files,
  packs,
  selected,
  onSelect,
  agentChanged,
}: {
  files: readonly ContextFile[]
  packs: readonly ContextPack[]
  selected: string
  onSelect: (selection: string) => void
  agentChanged: (type: RevisionObjectType, id: string) => boolean
}) {
  const references = packs.filter((pack) => pack.kind === 'reference')
  const roles = packs.filter((pack) => pack.kind === 'role')
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <SectionHeader title="Claude Code files" />
      {groupFiles(files).map(([group, groupFilesList]) => (
        <div key={group}>
          <div className="truncate bg-muted/40 px-3 pt-2 pb-1 text-2xs font-semibold text-muted-foreground">
            {group}
          </div>
          {groupFilesList.map((file) => (
            <Item
              key={file.key}
              selected={selected === file.key}
              onSelect={() => {
                onSelect(file.key)
              }}
              title={file.label}
              detail={sizeText(file)}
              muted={!file.exists}
              agentChanged={agentChanged('context_file', file.key)}
            />
          ))}
        </div>
      ))}
      <section aria-label="Context packs">
        <SectionHeader
          title="Context packs"
          action={
            <NewButton
              label="New context pack"
              onClick={() => {
                onSelect(NEW_PACK)
              }}
            />
          }
        />
        {references.length === 0 && (
          <p className="px-3 py-3 text-xs text-muted-foreground">No packs yet. Create one to attach it to agents.</p>
        )}
        <PackItems packs={references} selected={selected} onSelect={onSelect} agentChanged={agentChanged} />
      </section>
      <section aria-label="Roles">
        <SectionHeader
          title="Roles"
          action={
            <NewButton
              label="New role"
              onClick={() => {
                onSelect(NEW_ROLE)
              }}
            />
          }
        />
        <PackItems packs={roles} selected={selected} onSelect={onSelect} agentChanged={agentChanged} />
      </section>
    </div>
  )
}
